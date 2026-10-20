// -----------------------------------------------------------------------------
// The InfluxDB hub: reads InfluxDB on a timer of the container, at the
// interval chosen in the configuration; publishes the states of the added
// devices when they change; fires the scene events (server unreachable and
// back, a query that fails); holds the queries, and the views the widget and
// the scene actions read.
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 10 minutes, beyond the fixed list of the core scheduler.
//
// One read = /ping (the health check and the version), then one request per
// query (a query that reads nothing while there is none, to check the access). The events already announced are kept in /data (src/store.js): a
// restart neither announces a failure twice nor forgets to say the server is
// back.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { buildQueryDevice, parseQueryId, queryIds, queryValues } from './devices.js';
import { hostOf, isCloud } from './config.js';
import { FailureLog } from './logs.js';
import { ERROR_KINDS, InfluxClient, InfluxError, SERVER_ERRORS } from './influxdb/client.js';
import { parseAnswer, seriesNames } from './influxdb/model.js';
import { MAX_QUERIES, MAX_SERIES, parseQueryFields, queryId, restoreQuery } from './queries.js';
import {
  CONNECTION_TEXT,
  ERROR_TEXT,
  QUERY_FIELD_TEXT,
  REPORT_TEXT,
  RESULT_TEXT,
  labelled,
  pick,
  sentence,
} from './texts.js';

const logger = createLogger({ name: 'influxdb-hub' });

export const WIDGET_KEY = 'values';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  SERVER_DOWN: 'server_unreachable',
  SERVER_UP: 'server_back',
  QUERY_FAILED: 'query_failed',
});

export const HUB_TIMINGS = {
  // A scene action or the widget reads again when the last read is older.
  freshMs: 15_000,
  // An unchanged value is sent again this often: Gladys marks a value older
  // than 48 h as outdated.
  heartbeatMs: 6 * 3600_000,
};

// Failed reads in a row before "InfluxDB is unreachable" is announced: a
// restart of InfluxDB (an update) does not start the scenes.
export const DOWN_AFTER_READS = 2;

const MAX_STATES_PER_REQUEST = 100;
// States per minute, at most (Gladys accepts 300): the budget of a read is
// its share of the minute; the values published longest ago go first, so
// that no feature waits forever.
export const MAX_STATES_PER_MINUTE = 240;
const MAX_FEATURE_NAME = 60;

const signature = (config) =>
  JSON.stringify([
    config.api,
    config.url,
    config.organization,
    config.database,
    config.auth,
    config.allowSelfSigned,
  ]);

/** A user mistake answered to a configuration action, in every language. */
export class AnswerError extends Error {
  constructor(messages) {
    super(messages.en);
    this.messages = messages;
  }
}

export const inEveryLanguage = (render) =>
  Object.fromEntries(Object.keys(REPORT_TEXT).map((language) => [language, render(language)]));

/** The configuration fields the chosen API needs, missing: a CONNECTION_TEXT key, or null. */
function missingField(config) {
  if (config.api === 'v2' && !config.organization) {
    return 'noOrganization';
  }
  if (config.api === 'v3' && !config.database) {
    return 'noDatabase';
  }
  return null;
}

export class InfluxHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/influxdb/http.js)
   * @param {boolean} [options.timers] periodic timer (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.client = null;
    this.signature = null;
    /** @type {Map<string, object>} the queries, by id, with the series seen */
    this.queries = new Map();
    /** @type {Map<string, { series: object[], error: object|null }>} last result per query */
    this.results = new Map();
    this.version = null;
    this.error = null; // the server: InfluxError
    this.failedReads = 0;
    this.readAt = 0;
    this.polling = null;
    this.generation = 0;
    /** Last value published per feature external id, and when. */
    this.published = new Map();
    this.publishedAt = new Map();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    // What was announced to the scenes, kept across restarts.
    this.events = { down: null, failing: {} };
    this.pollTimer = null;
    this.stopped = false;
    // What fails again at every cycle (Gladys refusing, the reading loop):
    // one line when it starts, one when it ends.
    this.failureLog = new FailureLog(logger);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    for (const entry of Array.isArray(saved.queries) ? saved.queries : []) {
      const query = restoreQuery(entry);
      if (query && this.queries.size < MAX_QUERIES) {
        this.queries.set(query.id, query);
      }
    }
    const events = saved.events ?? {};
    this.events = {
      down: Number.isFinite(events.down?.since) ? { since: events.down.since } : null,
      failing: events.failing && typeof events.failing === 'object' ? events.failing : {},
    };
    if (this.queries.size > 0) {
      logger.info(`${this.queries.size} query(ies) loaded`);
    }
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.published.clear();
    this.publishedAt.clear();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const changed = this.signature !== signature(config);
    this.config = config;
    if (changed) {
      this.generation += 1; // a read in progress for the old server is ignored
      this.signature = signature(config);
      this.client =
        config.url && !missingField(config)
          ? new InfluxClient({
              url: config.url,
              api: config.api,
              organization: config.organization,
              database: config.database,
              auth: config.auth,
              insecure: config.allowSelfSigned,
              request: this.request,
            })
          : null;
      this.version = null;
      this.results.clear();
      this.error = null;
      this.failedReads = 0;
      this.readAt = 0;
      this.transports.clear();
    }
    await this.pollAll({ publish: true });
    this.schedulePoll();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    await this.store.flush();
  }

  save() {
    return this.store.save({ queries: [...this.queries.values()], events: this.events });
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAll();
        this.failureLog.recover('poll', 'Reading InfluxDB works again');
      } catch (err) {
        this.failureLog.fail('poll', `Poll failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Reading -------------------------------------------------------------------

  async pollAll({ publish = false, fresh = false } = {}) {
    const changed = await this.poll({ fresh });
    await this.afterChanges(changed, { publish });
  }

  /** Gladys asks for a refresh (onPoll): read now. */
  async pollDevice() {
    await this.pollAll();
  }

  /** Read again when the last read is older than `freshMs` (scene actions, widget). */
  async refreshIfStale() {
    if (this.client && this.now() - this.readAt >= this.timings.freshMs) {
      await this.pollAll();
    }
  }

  /**
   * Read and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll({ fresh = false } = {}) {
    if (!this.client) {
      return Promise.resolve(false);
    }
    if (this.polling && (fresh || this.pollingGeneration !== this.generation)) {
      // A read started before a query or a new configuration: read again
      // once it is over.
      return this.polling.catch(() => {}).then(() => this.poll());
    }
    if (!this.polling) {
      this.pollingGeneration = this.generation;
      this.polling = this.read().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  async read() {
    const { generation } = this;
    const before = this.widgetSignature();
    let version = null;
    let error = null;
    const results = new Map();
    try {
      version = await this.client.version();
      if (this.queries.size === 0) {
        await this.client.check();
      }
      for (const query of this.queries.values()) {
        results.set(query.id, await this.runQuery(query.query));
      }
    } catch (caught) {
      error = asError(caught);
    }
    if (generation !== this.generation) {
      return false; // the configuration changed meanwhile
    }
    this.readAt = this.now();
    this.applyServer(version, error, results);
    await this.serverEvents();
    if (!this.error) {
      await this.queryEvents();
    }
    await this.publishStates();
    return before !== this.widgetSignature();
  }

  /** What the widget shows: it is refreshed when this changes. */
  widgetSignature() {
    return JSON.stringify([
      this.error?.kind,
      [...this.results].map(([id, result]) => [
        id,
        result.error?.kind ?? result.error?.result,
        result.series.map((entry) => entry.value),
      ]),
    ]);
  }

  /**
   * One query: its series, or the reason it has none. A server error (no
   * answer, refused credentials, unknown organization or database) is
   * thrown; a query error is kept.
   */
  async runQuery(text) {
    try {
      const parsed = parseAnswer(await this.client.query(text));
      if (parsed.error === 'stream') {
        return { series: [], error: { kind: ERROR_KINDS.QUERY, detail: parsed.detail } };
      }
      return {
        series: parsed.series,
        error: parsed.error ? { result: parsed.error } : null,
      };
    } catch (err) {
      if (SERVER_ERRORS.has(err.kind)) {
        throw err;
      }
      return { series: [], error: { kind: err.kind, detail: err.detail ?? err.message } };
    }
  }

  serverName() {
    return hostOf(this.config.url);
  }

  applyServer(version, error, results) {
    if (error) {
      if (this.error?.kind !== error.kind) {
        logger.warn(`InfluxDB ${this.serverName()}: ${error.message}`);
      }
      this.error = error;
      this.failedReads += 1;
      return; // the last values stand
    }
    if (this.error) {
      logger.info(`InfluxDB ${this.serverName()} answers again`);
    }
    if (version !== this.version) {
      logger.info(`InfluxDB ${version} at ${this.serverName()}`);
    }
    this.error = null;
    this.failedReads = 0;
    this.version = version;
    let changed = false;
    for (const [id, result] of results) {
      const query = this.queries.get(id);
      if (!query) {
        continue; // removed during the read
      }
      const previous = JSON.stringify(this.results.get(id)?.error ?? null);
      if (result.error && JSON.stringify(result.error) !== previous) {
        logger.warn(`Query "${query.name}": ${result.error.detail ?? result.error.result}`);
      }
      this.results.set(id, result);
      changed = this.registerSeries(query, result.series) || changed;
    }
    if (changed) {
      this.save();
    }
  }

  /**
   * Give a feature to the series not seen before, up to MAX_SERIES per query:
   * its name is set now and kept (Gladys freezes it at creation anyway).
   * @returns {boolean} whether new series were registered
   */
  registerSeries(query, series) {
    const fresh = series.filter((entry) => !query.series[entry.key]);
    if (fresh.length === 0) {
      return false;
    }
    const room = MAX_SERIES - Object.keys(query.series).length;
    if (room <= 0) {
      return false;
    }
    const names = seriesNames(series, query.name, query.label);
    const taken = new Set(Object.values(query.series).map((entry) => entry.name));
    const sorted = [...fresh].sort((a, b) => names.get(a.key).localeCompare(names.get(b.key)));
    if (sorted.length > room) {
      logger.warn(`Query "${query.name}": ${MAX_SERIES} series at most, the others are left out`);
    }
    for (const entry of sorted.slice(0, room)) {
      const base = names.get(entry.key).slice(0, MAX_FEATURE_NAME);
      let name = base;
      for (let index = 2; taken.has(name); index += 1) {
        name = `${base.slice(0, MAX_FEATURE_NAME - 5)} (${index})`;
      }
      taken.add(name);
      query.series[entry.key] = { name };
    }
    return true;
  }

  // --- Scene events --------------------------------------------------------------

  /**
   * "InfluxDB is unreachable" after DOWN_AFTER_READS failed reads in a row,
   * "InfluxDB answers again" once, when it was announced. Marked announced
   * only once Gladys accepted the event (tried again at the next read).
   */
  async serverEvents() {
    const language = this.config.language;
    if (this.error && !this.events.down && this.failedReads >= DOWN_AFTER_READS) {
      const accepted = await this.fireEvent(TRIGGERS.SERVER_DOWN, {
        error: pick(ERROR_TEXT[this.error.kind] ?? ERROR_TEXT.http, language),
        error_kind: this.error.kind,
      });
      if (accepted) {
        this.events.down = { since: this.now() };
        this.save();
      }
    } else if (!this.error && this.events.down) {
      const accepted = await this.fireEvent(TRIGGERS.SERVER_UP, {
        duration_minutes: Math.max(0, Math.round((this.now() - this.events.down.since) / 60_000)),
      });
      if (accepted) {
        this.events.down = null;
        this.save();
      }
    }
  }

  /** "A query fails": once per failure, again only after the query worked. */
  async queryEvents() {
    const { failing } = this.events;
    let changed = false;
    for (const [id, query] of this.queries) {
      const result = this.results.get(id);
      if (!result) {
        continue;
      }
      // An empty answer is not a failure (no data for now).
      const failed = Boolean(result.error);
      if (!failed && failing[id]) {
        delete failing[id];
        changed = true;
      } else if (failed && !failing[id]) {
        const accepted = await this.fireEvent(TRIGGERS.QUERY_FAILED, {
          name: query.name,
          error: this.queryProblem(query, this.config.language) ?? '',
        });
        if (!accepted) {
          break; // Gladys refuses: try again at the next read
        }
        failing[id] = true;
        changed = true;
      }
    }
    for (const id of Object.keys(failing)) {
      if (!this.queries.has(id)) {
        delete failing[id];
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  /** @returns {Promise<boolean>} whether Gladys accepted the event */
  async fireEvent(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      logger.debug(`${key}: ${JSON.stringify(data)}`);
      this.failureLog.recover('event', 'Scene events accepted again');
      return true;
    } catch (err) {
      this.failureLog.fail('event', `Scene event refused: ${err.message}`);
      return false;
    }
  }

  // --- Devices -----------------------------------------------------------------

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  discoveredDevices() {
    return [...this.queries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((query) => buildQueryDevice(this.gladys, query));
  }

  /** Publish the Discovery list when it changed (a query added, a new series…). */
  async publishDevices({ force = false } = {}) {
    // Nothing read yet: keep the list Gladys has (an empty list only once
    // the address is removed from the configuration).
    if (!this.client) {
      if (force) {
        await this.sendDiscovered([]);
      }
      return;
    }
    if (this.readAt === 0 && !force) {
      return;
    }
    await this.sendDiscovered(this.discoveredDevices(), { force });
  }

  async sendDiscovered(devices, { force = false } = {}) {
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.failureLog.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.failureLog.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read again, publish the list again. */
  async rediscover() {
    await this.poll();
    await this.publishDevices({ force: true });
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    const query = this.queries.get(parseQueryId(this.gladys, device.external_id));
    if (!query) {
      return;
    }
    if (!this.error) {
      await this.sendStates(this.valuesOf(query), { force: true });
    }
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  valuesOf(query) {
    return queryValues(this.gladys, query, this.results.get(query.id)?.series ?? []);
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  /** The states of the added devices that changed (or are due for a heartbeat). */
  async publishStates() {
    // A server that does not answer: its last values are not sent again as
    // fresh ones (the badge says unreachable, Gladys shows their age).
    if (this.error) {
      return;
    }
    const values = [];
    for (const query of this.queries.values()) {
      if (this.isCreated(queryIds(this.gladys, query.id).device)) {
        values.push(...this.valuesOf(query));
      }
    }
    await this.sendStates(values);
  }

  async sendStates(values, { force = false } = {}) {
    const now = this.now();
    const known = values.filter(({ value }) => value !== null); // unknown: the last value stands
    const changed = known.filter(
      ({ externalId, value }) => force || this.published.get(externalId) !== value,
    );
    const due = known.filter(
      ({ externalId, value }) =>
        !force &&
        this.published.get(externalId) === value &&
        now - (this.publishedAt.get(externalId) ?? 0) >= this.timings.heartbeatMs,
    );
    const budget = Math.max(
      10,
      Math.floor((MAX_STATES_PER_MINUTE * (this.config?.pollIntervalMs ?? 60_000)) / 60_000),
    );
    const age = ({ externalId }) => this.publishedAt.get(externalId) ?? 0;
    const states = [...changed.sort((a, b) => age(a) - age(b)), ...due]
      .slice(0, force ? Infinity : budget)
      .map(({ externalId, value }) => ({ device_feature_external_id: externalId, state: value }));
    for (let at = 0; at < states.length; at += MAX_STATES_PER_REQUEST) {
      const batch = states.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishStates(batch);
        for (const state of batch) {
          this.published.set(state.device_feature_external_id, state.state);
          this.publishedAt.set(state.device_feature_external_id, now);
        }
        this.failureLog.recover('states', 'States accepted again');
      } catch (err) {
        this.failureLog.fail('states', `States refused: ${err.message}`);
      }
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: local or cloud, "unreachable" while the server is. */
  async publishTransports() {
    if (!this.client || this.readAt === 0) {
      return;
    }
    const { LOCAL, CLOUD, UNREACHABLE } = DEVICE_TRANSPORTS;
    const up = isCloud(this.config.url) ? CLOUD : LOCAL;
    const transport = this.error ? UNREACHABLE : up;
    const entries = [...this.queries.keys()]
      .map((id) => queryIds(this.gladys, id).device)
      .filter((id) => this.isCreated(id) && this.transports.get(id) !== transport)
      .map((id) => ({ external_id: id, transport }));
    for (let at = 0; at < entries.length; at += MAX_STATES_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.failureLog.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.failureLog.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The error of the server, in one language: "InfluxDB: does not answer". */
  errorText(language) {
    if (!this.error) {
      return '';
    }
    return labelled(
      'InfluxDB',
      pick(ERROR_TEXT[this.error.kind] ?? ERROR_TEXT.http, language),
      language,
    );
  }

  /** The status under the integration name. */
  connectionStatus() {
    const { url, invalidUrl } = this.config;
    if (invalidUrl) {
      return { connected: false, message: CONNECTION_TEXT.invalidUrl };
    }
    if (!url) {
      return { connected: false, message: CONNECTION_TEXT.noServer };
    }
    const missing = missingField(this.config);
    if (missing) {
      return { connected: false, message: CONNECTION_TEXT[missing] };
    }
    if (!this.error) {
      return { connected: true };
    }
    return { connected: false, message: inEveryLanguage((language) => this.errorText(language)) };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.failureLog.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.failureLog.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  // --- Configuration actions ---------------------------------------------------------

  /** "Test the connection": read now, one line. */
  async testConnection() {
    await this.pollAll({ publish: true, fresh: true });
    const status = this.connectionStatus();
    return inEveryLanguage((language) => {
      const text = REPORT_TEXT[language];
      if (!this.client) {
        return pick(status.message, language);
      }
      if (this.error) {
        return sentence([this.errorText(language)]);
      }
      const parts = [text.ok, `InfluxDB ${this.version}`];
      parts.push(this.queries.size > 0 ? text.queries(this.queries.size) : text.noQuery);
      for (const query of this.queries.values()) {
        const problem = this.queryProblem(query, language);
        if (problem) {
          parts.push(labelled(query.name, problem, language));
        }
      }
      return sentence(parts);
    });
  }

  /** Why a query shows nothing, in one language; null when it has series. */
  queryProblem(query, language) {
    const result = this.results.get(query.id);
    if (!result) {
      return null;
    }
    if (result.error?.result) {
      return pick(RESULT_TEXT[result.error.result], language);
    }
    if (result.error) {
      return `${pick(ERROR_TEXT[result.error.kind] ?? ERROR_TEXT.http, language)} (${result.error.detail})`;
    }
    return result.series.length === 0 ? pick(RESULT_TEXT.empty, language) : null;
  }

  /** "Add a query": checked against InfluxDB first, then saved. */
  async addQuery(fields) {
    const { query, error } = parseQueryFields(fields);
    if (error) {
      throw new AnswerError(QUERY_FIELD_TEXT[error]);
    }
    const existing = this.queries.get(query.id);
    const tooMany = () =>
      new AnswerError(inEveryLanguage((language) => REPORT_TEXT[language].tooMany(MAX_QUERIES)));
    if (!existing && this.queries.size >= MAX_QUERIES) {
      throw tooMany();
    }
    if (!this.client) {
      throw new AnswerError(this.connectionStatus().message ?? CONNECTION_TEXT.noServer);
    }
    let result = null;
    try {
      result = await this.runQuery(query.query);
    } catch (err) {
      logger.debug(`Query "${query.name}" not checked: ${err.message}`);
    }
    if (result?.error?.kind === ERROR_KINDS.QUERY) {
      throw new AnswerError(
        inEveryLanguage((language) => REPORT_TEXT[language].refused(result.error.detail)),
      );
    }
    if (result?.error?.result) {
      // Text only: never a number.
      throw new AnswerError(
        inEveryLanguage((language) =>
          REPORT_TEXT[language].refused(pick(RESULT_TEXT[result.error.result], language)),
        ),
      );
    }
    // Same text, type and label: the series and their names stay.
    const same =
      existing &&
      existing.query === query.query &&
      existing.type === query.type &&
      existing.label === query.label;
    const saved = { ...query, series: same ? existing.series : {} };
    if (!existing && this.queries.size >= MAX_QUERIES) {
      throw tooMany(); // another "Add a query" finished during the check
    }
    this.queries.set(saved.id, saved);
    this.generation += 1; // a read in progress does not know this query
    if (result) {
      this.results.set(saved.id, result);
      this.registerSeries(saved, result.series);
    } else {
      this.results.delete(saved.id);
    }
    await this.save();
    logger.info(`Query ${existing ? 'updated' : 'added'}: ${saved.name}`);
    await this.publishDevices();
    if (this.isCreated(queryIds(this.gladys, saved.id).device)) {
      await this.sendStates(this.valuesOf(saved), { force: true });
    }
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
    const count = result?.series.length ?? 0;
    return inEveryLanguage((language) => {
      const text = REPORT_TEXT[language];
      const parts = [existing ? text.updated(saved.name) : text.added(saved.name)];
      if (!result) {
        parts.push(text.notChecked);
      } else if (result.error) {
        parts.push(this.queryProblem(saved, language));
      } else if (count === 0) {
        parts.push(pick(RESULT_TEXT.empty, language));
      } else {
        parts.push(text.series(count));
        if (count > MAX_SERIES) {
          parts.push(text.capped(MAX_SERIES));
        }
      }
      if (!this.isCreated(queryIds(this.gladys, saved.id).device)) {
        parts.push(text.discovery);
      }
      return sentence(parts);
    });
  }

  /** "Remove a query", by its name. */
  async removeQuery(fields) {
    const name = typeof fields?.name === 'string' ? fields.name.trim() : '';
    const query = name ? this.queries.get(queryId(name)) : null;
    if (!query) {
      throw new AnswerError(inEveryLanguage((language) => REPORT_TEXT[language].notFound(name)));
    }
    this.queries.delete(query.id);
    this.results.delete(query.id);
    delete this.events.failing[query.id];
    this.generation += 1;
    await this.save();
    logger.info(`Query removed: ${query.name}`);
    await this.publishDevices();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
    return inEveryLanguage((language) => {
      const text = REPORT_TEXT[language];
      return sentence([text.removed(query.name), text.queries(this.queries.size)]);
    });
  }
}

/** Anything thrown by the client, as an InfluxError. */
function asError(caught) {
  return caught?.kind ? caught : new InfluxError(ERROR_KINDS.HTTP, String(caught?.message));
}
