// -----------------------------------------------------------------------------
// An in-memory InfluxDB, seeded with the real answers of InfluxDB 1.11.8,
// 2.9.1 and 3 Core 3.12.1 (test/fixtures/real): the queries they answered,
// and the real error answers (syntax, unknown bucket, organization or
// database, refused token). Tests change its state (values, failures)
// between two reads.
// -----------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';

export const INFLUX_URL = 'http://192.0.2.20:8086';
export const INFLUX3_URL = 'http://192.0.2.20:8181';
export const TOKEN = 'test-token';

const directory = new URL('../fixtures/real/', import.meta.url);
export const fixtures = Object.fromEntries(
  readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => [name.slice(0, -5), JSON.parse(readFileSync(new URL(name, directory), 'utf8'))]),
);
const answer = (name) => structuredClone(fixtures[name]);

// The queries the fixtures answer.
export const QUERIES = {
  v2: {
    'from(bucket: "sensors") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "temperature") |> last()':
      'flux-last-by-room',
    'from(bucket: "sensors") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "temperature") |> group() |> mean()':
      'flux-mean',
    'from(bucket: "sensors") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "state") |> last()':
      'flux-string-and-boolean',
    'from(bucket: "sensors") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "power") |> last()':
      'flux-two-fields',
    'from(bucket: "sensors" |> range(': 'flux-compile-error',
    'from(bucket: "nobucket") |> range(start: -1h)': 'flux-bucket-not-found',
  },
  v1: {
    'SELECT last(value) FROM temperature GROUP BY room': 'influxql-group-by',
    'SELECT mean(value) FROM temperature': 'influxql-mean',
    'SELECT last(watts), last(volts) FROM power': 'influxql-two-columns',
    'SELECT last(label) FROM state': 'influxql-string',
    'SELECT last(value) FROM temperature; SELECT last(value) FROM humidity':
      'influxql-two-statements',
    'SELEC value FROM temperature': 'influxql-parse-error',
  },
  v3: {
    'SELECT room, floor, last_value(value ORDER BY time) AS value FROM temperature GROUP BY room, floor':
      'sql-last-by-room',
    'SELECT avg(value) FROM temperature': 'sql-avg',
    'SELECT meter, watts, volts FROM power ORDER BY time DESC LIMIT 1': 'sql-two-columns',
    'SELECT * FROM nothing': 'sql-table-not-found',
    'SELEC 1': 'sql-parse-error',
  },
};
export const ROOMS = {
  v2: Object.keys(QUERIES.v2)[0],
  v1: Object.keys(QUERIES.v1)[0],
  v3: Object.keys(QUERIES.v3)[0],
};

const json = (status, body) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** An InfluxQL answer of one statement: { tags, value } per series. */
export function influxqlAnswer(measurement, series) {
  return json(200, {
    results: [
      {
        statement_id: 0,
        series: series.map(({ tags, value }) => ({
          name: measurement,
          ...(tags ? { tags } : {}),
          columns: ['time', 'last'],
          values: [[1792489718703, value]],
        })),
      },
    ],
  });
}

export class FakeInflux {
  /** @param {'v1'|'v2'|'v3'} api the API the server speaks */
  constructor(api = 'v1') {
    this.api = api;
    /** Answers by query text, as { status, headers, body }; tests add or change them. */
    this.answers = Object.fromEntries(
      Object.entries(QUERIES[api]).map(([text, name]) => [text, answer(name)]),
    );
    /** 'down', 'proxy', 'html', 'redirect', 'auth' or null */
    this.failure = null;
    this.calls = [];
  }

  /** Set the value of a single-series InfluxQL query. */
  setValue(text, value, tags) {
    this.answers[text] = influxqlAnswer('m', [{ tags, value }]);
  }

  /** @type {import('../../src/influxdb/http.js').httpRequest} */
  async request(url, { method = 'GET', body = '', headers = {} } = {}) {
    const target = new URL(url);
    this.calls.push({ method, path: `${target.pathname}${target.search}`, headers, body });
    switch (this.failure) {
      case 'down':
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      case 'proxy':
        return { status: 502, headers: {}, body: '<html>Bad Gateway</html>' };
      case 'html':
        return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>NAS</html>' };
      case 'redirect':
        return { status: 301, headers: { location: 'https://192.0.2.20/' }, body: '' };
      default:
    }
    const authorized = this.failure !== 'auth' && this.authorized(headers.authorization);
    if (target.pathname === '/ping') {
      if (this.api === 'v3' && !authorized) {
        return answer('ping-v3-no-token');
      }
      return answer(`ping-${this.api}`);
    }
    if (this.api === 'v2' && target.pathname === '/api/v2/query' && method === 'POST') {
      if (!authorized) {
        return answer('flux-unauthorized');
      }
      if (target.searchParams.get('org') !== 'home') {
        return answer('flux-org-not-found');
      }
      const { query } = JSON.parse(body);
      return structuredClone(this.answers[query]) ?? answer('flux-empty');
    }
    if (target.pathname === '/query' && method === 'GET' && this.api !== 'v2') {
      if (!authorized) {
        return answer(this.api === 'v3' ? 'influxql-v3-unauthorized' : 'influxql-auth-failed');
      }
      if (target.searchParams.get('db') !== 'sensors') {
        return answer('influxql-database-not-found');
      }
      const text = target.searchParams.get('q');
      return structuredClone(this.answers[text]) ?? answer('influxql-empty');
    }
    if (this.api === 'v3' && target.pathname === '/api/v3/query_sql') {
      if (!authorized) {
        return answer('sql-unauthorized');
      }
      if (target.searchParams.get('db') !== 'sensors') {
        return answer('sql-database-not-found');
      }
      const text = target.searchParams.get('q');
      return structuredClone(this.answers[text]) ?? answer('sql-empty');
    }
    if (this.api === 'v2') {
      return answer('sql-path-on-v2'); // the interface answers every other path
    }
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: '404 page not found' };
  }

  authorized(header) {
    if (this.api === 'v1') {
      return header === `Basic ${Buffer.from('reader:secret').toString('base64')}`;
    }
    return header === `Token ${TOKEN}` || (this.api === 'v3' && header === `Bearer ${TOKEN}`);
  }
}
