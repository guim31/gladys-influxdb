// -----------------------------------------------------------------------------
// HTTP client of InfluxDB, read-only, in one of three query languages chosen
// in the configuration (`api`):
//
//   - `v2`: Flux, `POST /api/v2/query?org=…` with `Authorization: Token …`,
//     annotated CSV in return (InfluxDB 2 and InfluxDB Cloud);
//   - `v1`: InfluxQL, `GET /query?db=…&q=…`, JSON in return; credentials as
//     Basic (InfluxDB 1) or a token (`Token …`: the v1 compatibility API of
//     InfluxDB 2, and InfluxDB 3 Core);
//   - `v3`: SQL, `GET /api/v3/query_sql?db=…&q=…&format=json` with
//     `Authorization: Bearer …` (InfluxDB 3 Core and Enterprise).
//
// `/ping` is the health check and gives the version (`X-Influxdb-Version`):
// open on InfluxDB 1 and 2, behind the token on InfluxDB 3.
//
// Errors are thrown as InfluxError with a `kind` (ERROR_KINDS): the hub and
// the texts know what to tell the user from it. The real answers of
// InfluxDB 1.11.8, 2.9.1 and 3 Core 3.12.1 are in test/fixtures/real.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';

export const API_VERSIONS = Object.freeze(['v2', 'v1', 'v3']);

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer, timeout, 502/503/504 of a reverse proxy
  TLS: 'tls', // the certificate does not verify (self-signed without the option)
  AUTH: 'auth', // 401/403: credentials refused or missing
  NOT_INFLUX: 'not_influx', // something answers, but not the API of the chosen version
  REDIRECT: 'redirect', // HTTP redirected (to HTTPS, to a login page)
  ORGANIZATION: 'organization', // v2: the organization does not exist
  DATABASE: 'database', // v1, v3: the database does not exist
  QUERY: 'query', // InfluxDB refused the query (syntax, unknown bucket, runtime)
  HTTP: 'http', // anything else
});

// Kinds that concern the server and its configuration, not one query.
export const SERVER_ERRORS = new Set([
  ERROR_KINDS.UNREACHABLE,
  ERROR_KINDS.TLS,
  ERROR_KINDS.AUTH,
  ERROR_KINDS.NOT_INFLUX,
  ERROR_KINDS.REDIRECT,
  ERROR_KINDS.ORGANIZATION,
  ERROR_KINDS.DATABASE,
]);

// Of those, the ones a user query can also meet for itself (a database read by
// its full name, a token without access to one bucket): from a query, they
// concern that query only. check() tells the server apart.
export const QUERY_SERVER_ERRORS = new Set([
  ERROR_KINDS.UNREACHABLE,
  ERROR_KINDS.TLS,
  ERROR_KINDS.NOT_INFLUX,
  ERROR_KINDS.REDIRECT,
  ERROR_KINDS.ORGANIZATION,
]);

export class InfluxError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message for the logs (never a password nor a token)
   * @param {object} [extra] e.g. { status, detail }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'InfluxError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// An organization id, as in the address of the InfluxDB 2 interface.
const ORG_ID = /^[0-9a-f]{16}$/;

/**
 * The Authorization header of the configuration, per API: a token wins over
 * the user and password (InfluxQL only); none when nothing is filled.
 * @param {string} api v2, v1 or v3
 * @param {{ token?: string, username?: string, password?: string }} auth
 */
export function authorizationHeader(api, { token = '', username = '', password = '' } = {}) {
  if (token) {
    return api === 'v3' ? `Bearer ${token}` : `Token ${token}`;
  }
  if (api === 'v1' && (username || password)) {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  return null;
}

/** The message of an InfluxDB error body: `{ message }`, `{ error }`, or plain text. */
export function errorDetail(body) {
  const text = typeof body === 'string' ? body.trim() : '';
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.message ?? parsed?.error;
    if (typeof detail === 'string' && detail) {
      return detail.slice(0, 300);
    }
  } catch {
    // plain text (the SQL API of InfluxDB 3)
  }
  return text.startsWith('<') ? '' : text.slice(0, 300);
}

const DATABASE_NOT_FOUND = /database not found/i;

// Queries that read no data (tried on InfluxDB 1.11, 2.9 and 3 Core, with a
// read-only token too).
const CHECKS = {
  v2: 'import "array"\narray.from(rows: [{_value: 1}])',
  // Refused with "database not found" on InfluxDB 1 and 3 (not on the
  // compatibility API of InfluxDB 2, which answers an empty list).
  v1: 'SHOW RETENTION POLICIES',
  v3: 'SELECT 1',
};

export class InfluxClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL, without trailing slash
   * @param {string} options.api v2, v1 or v3
   * @param {string} [options.organization] v2
   * @param {string} [options.database] v1, v3
   * @param {object} [options.auth] { token, username, password }
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {typeof httpRequest} [options.request] test seam
   * @param {number} [options.timeoutMs]
   */
  constructor({
    url,
    api,
    organization = '',
    database = '',
    auth = {},
    insecure = false,
    request = httpRequest,
    timeoutMs = 15_000,
  }) {
    this.url = url;
    this.api = api;
    this.organization = organization;
    this.database = database;
    this.authorization = authorizationHeader(api, auth);
    this.insecure = insecure;
    this.request = request;
    this.timeoutMs = timeoutMs;
  }

  /**
   * One request: status, headers and body.
   * @throws {InfluxError} on a network, TLS, redirect, auth or proxy error
   */
  async send(path, { method = 'GET', body = '', headers = {} } = {}) {
    const all = { accept: 'application/json', ...headers };
    if (this.authorization) {
      all.authorization = this.authorization;
    }
    let response;
    try {
      response = await this.request(`${this.url}${path}`, {
        method,
        body,
        headers: all,
        insecure: this.insecure,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (TLS_CODES.has(err.code)) {
        throw new InfluxError(ERROR_KINDS.TLS, `Certificate refused (${err.code})`);
      }
      if (!err.code) {
        // The server answers, but not as expected (an answer too large…).
        throw new InfluxError(ERROR_KINDS.HTTP, err.message);
      }
      throw new InfluxError(ERROR_KINDS.UNREACHABLE, `${err.code}`);
    }
    const { status } = response;
    const detail = errorDetail(response.body);
    if (status >= 300 && status < 400) {
      throw new InfluxError(ERROR_KINDS.REDIRECT, `Redirected (HTTP ${status})`, { status });
    }
    if ([502, 503, 504].includes(status)) {
      // A reverse proxy in front of a stopped server (InfluxDB answers 503
      // only while it starts).
      throw new InfluxError(ERROR_KINDS.UNREACHABLE, `HTTP ${status}`, { status });
    }
    if (status === 401 || status === 403) {
      throw new InfluxError(ERROR_KINDS.AUTH, `Refused (HTTP ${status}): ${detail}`, {
        status,
        detail,
      });
    }
    return { ...response, detail };
  }

  /**
   * The health check: the version of the server ("2.9.1").
   * @throws {InfluxError}
   */
  async version() {
    const response = await this.send('/ping');
    const header = response.headers?.['x-influxdb-version'];
    let version = typeof header === 'string' ? header : '';
    if (!version && response.status === 200) {
      try {
        version = String(JSON.parse(response.body)?.version ?? '');
      } catch {
        version = '';
      }
    }
    if (version) {
      return version.replace(/^v/, '');
    }
    if (response.status === 204) {
      // A proxy that drops the header: InfluxDB still, its version unknown.
      return '?';
    }
    throw new InfluxError(
      ERROR_KINDS.NOT_INFLUX,
      `Not an InfluxDB answer (HTTP ${response.status})`,
      { status: response.status },
    );
  }

  /**
   * Run a query in the language of the configured API.
   * @param {string} text Flux, InfluxQL or SQL
   * @returns {Promise<{ format: 'flux'|'influxql'|'sql', body: string }>}
   * @throws {InfluxError}
   */
  async query(text) {
    if (this.api === 'v2') {
      return { format: 'flux', body: await this.flux(text) };
    }
    if (this.api === 'v3') {
      return { format: 'sql', body: await this.sql(text) };
    }
    return { format: 'influxql', body: await this.influxql(text) };
  }

  /**
   * A query that reads nothing, to check the token, the organization and the
   * database at every read (/ping checks nothing of them on InfluxDB 1 and
   * 2). Only the errors that concern the server are thrown.
   * @throws {InfluxError}
   */
  async check() {
    try {
      await this.query(CHECKS[this.api]);
    } catch (err) {
      if (SERVER_ERRORS.has(err.kind)) {
        throw err;
      }
    }
  }

  async flux(text) {
    const org = this.organization;
    const params = new URLSearchParams(ORG_ID.test(org) ? { orgID: org } : { org });
    const response = await this.send(`/api/v2/query?${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/csv' },
      body: JSON.stringify({
        query: text,
        type: 'flux',
        dialect: { annotations: ['datatype', 'group', 'default'], header: true, delimiter: ',' },
      }),
    });
    const { status, detail } = response;
    const isCsv = /text\/csv/i.test(response.headers?.['content-type'] ?? '');
    if (status === 200 && isCsv) {
      return response.body;
    }
    if (/organization\b.*\bnot found/i.test(detail)) {
      throw new InfluxError(ERROR_KINDS.ORGANIZATION, `Organization not found: ${detail}`, {
        status,
        detail,
      });
    }
    if ((status === 400 || status === 404) && /"code"/.test(response.body)) {
      // `invalid` (compilation, runtime) and `not found` (bucket) concern
      // the query: the API itself answered.
      throw new InfluxError(ERROR_KINDS.QUERY, `Flux: ${detail}`, { status, detail });
    }
    throw this.unexpected(status, detail);
  }

  async influxql(text) {
    const params = new URLSearchParams({ q: text, epoch: 'ms' });
    if (this.database) {
      params.set('db', this.database);
    }
    const response = await this.send(`/query?${params}`);
    const { status, detail } = response;
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = null;
    }
    if (status === 200 && Array.isArray(parsed?.results)) {
      // An error per statement (syntax on InfluxDB 3, unknown database).
      const failed = parsed.results.find((result) => typeof result?.error === 'string');
      if (failed) {
        throw this.statementError(failed.error, status);
      }
      return response.body;
    }
    if (status === 400 && typeof parsed?.error === 'string') {
      throw this.statementError(parsed.error, status);
    }
    throw this.unexpected(status, detail);
  }

  async sql(text) {
    const params = new URLSearchParams({ db: this.database, q: text, format: 'json' });
    const response = await this.send(`/api/v3/query_sql?${params}`);
    const { status, detail } = response;
    const isJson = /json/i.test(response.headers?.['content-type'] ?? '');
    if (status === 200 && isJson) {
      return response.body;
    }
    if (DATABASE_NOT_FOUND.test(detail)) {
      throw new InfluxError(ERROR_KINDS.DATABASE, `Database not found: ${detail}`, {
        status,
        detail,
      });
    }
    if (status === 400 && detail) {
      // Plain text: "SQL error: ParserError…", "Error during planning…".
      throw new InfluxError(ERROR_KINDS.QUERY, `SQL: ${detail}`, { status, detail });
    }
    throw this.unexpected(status, detail);
  }

  statementError(message, status) {
    const detail = message.slice(0, 300);
    if (DATABASE_NOT_FOUND.test(detail)) {
      return new InfluxError(ERROR_KINDS.DATABASE, `Database not found: ${detail}`, {
        status,
        detail,
      });
    }
    return new InfluxError(ERROR_KINDS.QUERY, `InfluxQL: ${detail}`, { status, detail });
  }

  /** A 404, an HTML page (the InfluxDB 2 interface on an unknown path), a 500. */
  unexpected(status, detail) {
    if (status === 200 || status === 404 || status === 405) {
      return new InfluxError(
        ERROR_KINDS.NOT_INFLUX,
        `Not the ${this.api} API of InfluxDB (HTTP ${status})`,
        { status },
      );
    }
    return new InfluxError(ERROR_KINDS.HTTP, `HTTP ${status}${detail ? `: ${detail}` : ''}`, {
      status,
      detail: detail || `HTTP ${status}`,
    });
  }
}
