// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One InfluxDB server, read in the query language of the API chosen (Flux,
// InfluxQL or SQL, see src/influxdb/client.js). The address typed by the user
// can be a page copied from the browser: the address of the InfluxDB 2
// interface (`http://192.0.2.5:8086/orgs/0123456789abcdef/data-explorer`)
// also gives the organization when the field is empty. A path prefix (a
// reverse proxy) is kept.
//
// The queries are not configuration fields (Gladys has no list field): the
// "Add a query" action stores them under /data, see src/queries.js.
// -----------------------------------------------------------------------------

import { API_VERSIONS } from './influxdb/client.js';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Refresh intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['30', '60', '120', '300', '600'];

export const DEFAULT_CONFIG = {
  api_version: 'v2',
  url: '',
  organization: '',
  database: '',
  token: '',
  username: '',
  password: '',
  poll_interval: '60',
  allow_self_signed: false,
  language: 'fr',
};

// InfluxDB 1 and 2 listen on 8086, InfluxDB 3 on 8181.
const DEFAULT_PORTS = { v1: 8086, v2: 8086, v3: 8181 };

// The pages of the InfluxDB 2 interface, and the API itself: the base is before them.
const UI_PAGES = /\/(?:orgs|signin|me|api\/v[123]|query|ping|health|write)(?:\/.*)?$/i;
const ORG_IN_PAGE = /\/orgs\/([0-9a-f]{16})(?:\/|$)/i;

// InfluxDB Cloud (Serverless, Dedicated): the badge of the devices says "cloud".
const CLOUD_HOSTS = /(?:^|\.)influxdata\.(?:com|io)$/i;

/**
 * Parse the address typed by the user: the base URL of the API (a bare host
 * such as `192.0.2.5:8086`, a page of the interface, or the API URL itself),
 * and the organization id found in a page of the InfluxDB 2 interface. HTTP
 * by default, and the default port when none is given on a bare host.
 * @param {unknown} raw
 * @param {number} defaultPort
 * @returns {{ url: string, orgId: string }|null} null when unusable
 */
export function parseBaseUrl(raw, defaultPort) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs: there are fields.
  if (url.username || url.password) {
    return null;
  }
  if (!hasScheme && !url.port) {
    url.port = String(defaultPort);
  }
  const orgId = url.pathname.match(ORG_IN_PAGE)?.[1]?.toLowerCase() ?? '';
  const path = url.pathname.replace(UI_PAGES, '').replace(/\/+$/, '');
  return { url: `${url.origin}${path}`, orgId };
}

/** The address shown to the user: host and path, without scheme. */
export const hostOf = (baseUrl) => baseUrl.replace(/^https?:\/\//, '');

/** Whether the server is InfluxDB Cloud (the transport badge of the devices). */
export const isCloud = (baseUrl) => {
  try {
    return CLOUD_HOSTS.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
};

const isTrue = (value) => value === true || value === 'true';

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // A pasted password or token often carries a trailing space or new line.
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };
  const api = pick('api_version', API_VERSIONS);
  const typed = text('url');
  const parsed = parseBaseUrl(typed, DEFAULT_PORTS[api]);
  return {
    api,
    url: parsed?.url ?? null,
    invalidUrl: Boolean(typed) && !parsed,
    organization: text('organization') || parsed?.orgId || '',
    database: text('database'),
    auth: {
      token: text('token'),
      username: text('username'),
      password: typeof source.password === 'string' ? source.password : '',
    },
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    allowSelfSigned: isTrue(source.allow_self_signed),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
