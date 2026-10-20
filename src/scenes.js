// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// The values of the added queries are already device states (scene
// conditions, "read a device value"). This action does what a device cannot:
// run a query once, in a scene, without making it a device — a figure for a
// message ("2.4 kWh used today"), a check before an action.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './influxdb/client.js';
import { parseAnswer, seriesNames } from './influxdb/model.js';
import { MAX_QUERY_LENGTH, featureValue } from './queries.js';
import { ACTION_TEXT, CONNECTION_TEXT, ERROR_TEXT, RESULT_TEXT, labelled, pick } from './texts.js';

// Series listed in the `text` output of a query, at most.
export const MAX_LISTED_SERIES = 10;

const fail = (text, language, cause) => {
  throw new Error(pick(text, language), cause ? { cause } : undefined);
};

export const SCENE_ACTIONS = {
  async query_value(hub, { fields = {} }) {
    const language = hub.config?.language;
    if (!hub.client) {
      fail(hub.config?.url ? hub.connectionStatus().message : ACTION_TEXT.noServer, language);
    }
    const text = typeof fields.query === 'string' ? fields.query.trim() : '';
    if (!text || text.length > MAX_QUERY_LENGTH) {
      fail(ACTION_TEXT.noQuery, language);
    }
    let parsed;
    try {
      parsed = parseAnswer(await hub.client.query(text));
    } catch (err) {
      const message = pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT.http, language);
      throw new Error(err.kind === ERROR_KINDS.QUERY ? `${message}: ${err.detail}` : message, {
        cause: err,
      });
    }
    if (parsed.error === 'stream') {
      throw new Error(`${pick(ERROR_TEXT.query, language)}: ${parsed.detail}`);
    }
    if (parsed.error) {
      fail(RESULT_TEXT[parsed.error] ?? CONNECTION_TEXT.noServer, language);
    }
    const series = parsed.series.filter((entry) => entry.value !== null);
    const round = (value) => featureValue('number', value);
    // Named by the labels that differ from one series to the other.
    const names = seriesNames(series, '');
    const named = series.slice(0, MAX_LISTED_SERIES).map((entry) => {
      const name = names.get(entry.key);
      return name ? labelled(name, round(entry.value), language) : String(round(entry.value));
    });
    return {
      // No series: 0, and `series` says so.
      value: series.length > 0 ? round(series[0].value) : 0,
      series: series.length,
      text:
        series.length > named.length
          ? `${named.join(', ')}, +${series.length - named.length}`
          : named.join(', '),
    };
  },
};
