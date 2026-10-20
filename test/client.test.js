// The configuration, the client and the parsers, on the real answers of
// InfluxDB 1.11.8, 2.9.1 and 3 Core 3.12.1 (test/fixtures/real): series,
// names, and every kind of error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeConfig, parseBaseUrl, isCloud } from '../src/config.js';
import { ERROR_KINDS, InfluxClient, authorizationHeader } from '../src/influxdb/client.js';
import {
  parseFlux,
  parseFluxCsv,
  parseInfluxql,
  parseSql,
  seriesNames,
} from '../src/influxdb/model.js';
import { featureValue, parseQueryFields, queryId, restoreQuery } from '../src/queries.js';
import { fixtures } from './helpers/fakeInflux.js';

const body = (name) => fixtures[name].body;

/** A client whose every request gets the given fixture. */
const clientWith = (api, name, options = {}) =>
  new InfluxClient({
    url: 'http://192.0.2.20:8086',
    api,
    organization: 'home',
    database: 'sensors',
    request: async () => structuredClone(fixtures[name]),
    ...options,
  });

const values = (parsed, names = seriesNames(parsed.series, 'Q')) =>
  Object.fromEntries(parsed.series.map((entry) => [names.get(entry.key), entry.value]));

test('addresses: bare host with the default port, pages of the interface, prefixes', () => {
  assert.deepEqual(parseBaseUrl('192.0.2.5', 8086), { url: 'http://192.0.2.5:8086', orgId: '' });
  assert.deepEqual(
    parseBaseUrl('http://192.0.2.5:8086/orgs/0123456789ABCDEF/data-explorer?bucket=x', 8086),
    { url: 'http://192.0.2.5:8086', orgId: '0123456789abcdef' },
  );
  assert.equal(
    parseBaseUrl('https://influx.example/influx/query', 8086).url,
    'https://influx.example/influx',
  );
  assert.equal(parseBaseUrl('https://influx.example', 8086).url, 'https://influx.example');
  assert.equal(parseBaseUrl('ftp://x', 8086), null);
  assert.equal(parseBaseUrl('http://user:pass@192.0.2.5:8086', 8086), null);
  assert.ok(isCloud('https://eu-central-1-1.aws.cloud2.influxdata.com'));
  assert.ok(!isCloud('http://192.0.2.5:8086'));
});

test('configuration: defaults, port per API, organization from the address', () => {
  const empty = normalizeConfig({});
  assert.equal(empty.api, 'v2');
  assert.equal(empty.url, null);
  assert.equal(empty.pollIntervalMs, 60_000);
  assert.equal(empty.language, 'fr');
  assert.equal(
    normalizeConfig({ api_version: 'v3', url: '192.0.2.5' }).url,
    'http://192.0.2.5:8181',
  );
  const v2 = normalizeConfig({
    url: 'http://192.0.2.5:8086/orgs/0123456789abcdef',
    token: ' t \n',
  });
  assert.equal(v2.organization, '0123456789abcdef');
  assert.equal(v2.auth.token, 't');
  assert.equal(normalizeConfig({ url: 'ftp://x' }).invalidUrl, true);
  assert.equal(normalizeConfig({ poll_interval: '7' }).pollIntervalMs, 60_000);
});

test('credentials: a token per API, Basic for InfluxQL only', () => {
  assert.equal(authorizationHeader('v2', { token: 't' }), 'Token t');
  assert.equal(authorizationHeader('v1', { token: 't', username: 'u' }), 'Token t');
  assert.equal(authorizationHeader('v3', { token: 't' }), 'Bearer t');
  assert.equal(
    authorizationHeader('v1', { username: 'u', password: 'p' }),
    `Basic ${Buffer.from('u:p').toString('base64')}`,
  );
  assert.equal(authorizationHeader('v2', { username: 'u', password: 'p' }), null);
  assert.equal(authorizationHeader('v1', {}), null);
});

test('Flux: one series per table, the last row, booleans as 1, text left out', () => {
  assert.deepEqual(values(parseFlux(body('flux-last-by-room'))), {
    'kitchen 0': 21.5,
    'bedroom 1': 19.25,
    'attic 2': 15.75,
  });
  assert.deepEqual(values(parseFlux(body('flux-mean'))), { Q: 18.833333333333332 });
  // The string table is left out, the boolean one counts.
  const mixed = parseFlux(body('flux-string-and-boolean'));
  assert.deepEqual(
    mixed.series.map((entry) => [entry.labels._field, entry.value]),
    [['on', 1]],
  );
  // After pivot(): every numeric column is a series, like the two fields.
  assert.deepEqual(values(parseFlux(body('flux-pivot'))), { volts: 231.4, watts: 1250 });
  assert.deepEqual(
    parseFlux(body('flux-pivot')).series.map((entry) => entry.key),
    parseFlux(body('flux-two-fields')).series.map((entry) => entry.key),
    'pivoted or not, the same series',
  );
  assert.deepEqual(parseFlux(body('flux-empty')), { series: [] });
  // _start and _stop move at every read: never in the identity.
  const keys = parseFlux(body('flux-last-by-room')).series.map((entry) => entry.key);
  const later = body('flux-last-by-room').replaceAll('2026-10-20T08:50', '2026-10-20T09:50');
  assert.deepEqual(
    parseFlux(later).series.map((entry) => entry.key),
    keys,
  );
});

test('Flux CSV: quoted cells, and an error in the stream', () => {
  const csv =
    '#datatype,string,long,double,string\r\n#group,false,false,false,true\r\n#default,_result,,,\r\n' +
    ',result,table,_value,room\r\n,,0,1.5,"living, room"\r\n,,1,2,"say ""hi"""\r\n';
  assert.deepEqual(
    parseFluxCsv(csv)[0].rows.map((row) => row[4]),
    ['living, room', 'say "hi"'],
  );
  const failed = parseFlux(
    '#datatype,string,string\r\n#group,true,true\r\n#default,,\r\n,error,reference\r\n,panic: out of memory,\r\n',
  );
  assert.deepEqual(failed, { series: [], error: 'stream', detail: 'panic: out of memory' });
});

test('InfluxQL: tags, several columns, several statements, text', () => {
  assert.deepEqual(values(parseInfluxql(body('influxql-group-by'))), {
    attic: 15.75,
    bedroom: 19.25,
    kitchen: 21.5,
  });
  assert.deepEqual(values(parseInfluxql(body('influxql-mean'))), { Q: 18.833333333333332 });
  assert.deepEqual(values(parseInfluxql(body('influxql-two-columns'))), {
    last: 1250,
    last_1: 231.4,
  });
  assert.deepEqual(values(parseInfluxql(body('influxql-two-statements'))), {
    'temperature 0': 21.5,
    'humidity 1': 48.2,
  });
  assert.deepEqual(parseInfluxql(body('influxql-string')), { series: [], error: 'not_number' });
  assert.deepEqual(parseInfluxql(body('influxql-empty')), { series: [] });
  // InfluxDB 1, the compatibility API of InfluxDB 2 and InfluxDB 3: same series.
  const keys = (name) => parseInfluxql(body(name)).series.map((entry) => entry.key);
  assert.deepEqual(keys('influxql-v2-compat'), keys('influxql-group-by'));
  assert.deepEqual(keys('influxql-v3'), keys('influxql-group-by'));
});

test('SQL: text columns label, numeric columns are values, the first row wins', () => {
  assert.deepEqual(values(parseSql(body('sql-last-by-room'))), {
    'bedroom 1': 19.25,
    'kitchen 0': 21.5,
    'attic 2': 15.75,
  });
  assert.deepEqual(values(parseSql(body('sql-avg'))), { Q: 18.833333333333332 });
  assert.deepEqual(values(parseSql(body('sql-two-columns'))), { watts: 1250, volts: 231.4 });
  assert.deepEqual(values(parseSql(body('sql-boolean-and-string'))), { Q: 1 });
  // ORDER BY time DESC: the first row is the latest.
  assert.deepEqual(values(parseSql(body('sql-with-time'))), { Q: 48.2 });
  assert.deepEqual(parseSql(body('sql-empty')), { series: [] });
  assert.deepEqual(parseSql('[{"room":"a"}]'), { series: [], error: 'not_number' });
  assert.equal(parseSql('<html>').error, 'bad_answer');
});

test('series names: the chosen tag, or the tags that differ, preferring room', () => {
  const { series } = parseFlux(body('flux-last-by-room'));
  assert.deepEqual([...seriesNames(series, 'Q', 'floor').values()], ['0', '1', '2']);
  assert.deepEqual([...seriesNames(series, 'Q', 'nothing').values()], ['Q', 'Q', 'Q']);
});

test('the client tells the kinds of errors apart, on the real answers', async () => {
  const kind = async (api, name, text = 'q') => {
    try {
      await clientWith(api, name).query(text);
      return 'ok';
    } catch (err) {
      return err.kind;
    }
  };
  assert.equal(await kind('v2', 'flux-last-by-room'), 'ok');
  assert.equal(await kind('v2', 'flux-compile-error'), ERROR_KINDS.QUERY);
  assert.equal(await kind('v2', 'flux-runtime-error'), ERROR_KINDS.QUERY);
  assert.equal(await kind('v2', 'flux-bucket-not-found'), ERROR_KINDS.QUERY);
  assert.equal(await kind('v2', 'flux-org-not-found'), ERROR_KINDS.ORGANIZATION);
  assert.equal(await kind('v2', 'flux-unauthorized'), ERROR_KINDS.AUTH);
  assert.equal(await kind('v2', 'v2-path-on-v1'), ERROR_KINDS.AUTH);
  assert.equal(await kind('v1', 'influxql-parse-error'), ERROR_KINDS.QUERY);
  assert.equal(await kind('v1', 'influxql-v3-parse-error'), ERROR_KINDS.QUERY);
  assert.equal(await kind('v1', 'influxql-database-not-found'), ERROR_KINDS.DATABASE);
  assert.equal(await kind('v1', 'influxql-auth-failed'), ERROR_KINDS.AUTH);
  assert.equal(await kind('v1', 'influxql-no-credentials'), ERROR_KINDS.AUTH);
  assert.equal(await kind('v1', 'influxql-v2-unauthorized'), ERROR_KINDS.AUTH);
  assert.equal(await kind('v1', 'influxql-v3-unauthorized'), ERROR_KINDS.AUTH);
  assert.equal(await kind('v3', 'sql-last-by-room'), 'ok');
  assert.equal(await kind('v3', 'sql-parse-error'), ERROR_KINDS.QUERY);
  assert.equal(await kind('v3', 'sql-table-not-found'), ERROR_KINDS.QUERY);
  assert.equal(await kind('v3', 'sql-database-not-found'), ERROR_KINDS.DATABASE);
  assert.equal(await kind('v3', 'sql-unauthorized'), ERROR_KINDS.AUTH);
  // SQL asked of InfluxDB 2: its interface answers an HTML page.
  assert.equal(await kind('v3', 'sql-path-on-v2'), ERROR_KINDS.NOT_INFLUX);

  const detail = await clientWith('v2', 'flux-compile-error')
    .query('q')
    .catch((err) => err.detail);
  assert.match(detail, /^compilation failed: error @1:1-1:33: expected RPAREN/);
});

test('the health check reads the version, on every version', async () => {
  assert.equal(await clientWith('v1', 'ping-v1').version(), '1.11.8');
  assert.equal(await clientWith('v2', 'ping-v2').version(), '2.9.1');
  assert.equal(await clientWith('v3', 'ping-v3').version(), '3.12.1');
  await assert.rejects(clientWith('v3', 'ping-v3-no-token').version(), { kind: ERROR_KINDS.AUTH });
  const nas = clientWith('v3', 'ping-v3', {
    request: async () => ({ status: 200, headers: {}, body: '<html>NAS</html>' }),
  });
  await assert.rejects(nas.version(), { kind: ERROR_KINDS.NOT_INFLUX });
  const down = clientWith('v2', 'ping-v2', {
    request: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    },
  });
  await assert.rejects(down.version(), { kind: ERROR_KINDS.UNREACHABLE });
});

test('a real HTTP exchange over node:http', async (t) => {
  let seen = null;
  const server = createServer((request, response) => {
    seen = { url: request.url, authorization: request.headers.authorization };
    response.writeHead(204, { 'X-Influxdb-Version': 'v2.9.1' });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const client = new InfluxClient({
    url: `http://127.0.0.1:${server.address().port}`,
    api: 'v2',
    auth: { token: 'abc' },
  });
  assert.equal(await client.version(), '2.9.1');
  assert.deepEqual(seen, { url: '/ping', authorization: 'Token abc' });
});

test('query fields, ids and values', () => {
  assert.equal(queryId('  Room   Temperatures '), queryId('room temperatures'));
  assert.deepEqual(parseQueryFields({}), { error: 'name' });
  assert.deepEqual(parseQueryFields({ name: 'A' }), { error: 'query' });
  assert.deepEqual(parseQueryFields({ name: 'A', query: 'q', type: 'x' }), { error: 'type' });
  assert.deepEqual(parseQueryFields({ name: 'A', query: 'q', label: 'x'.repeat(65) }), {
    error: 'label',
  });
  const { query } = parseQueryFields({ name: 'A', query: ' q ', label: 'room' });
  assert.deepEqual(query, {
    id: queryId('A'),
    name: 'A',
    query: 'q',
    type: 'number',
    label: 'room',
  });
  assert.equal(restoreQuery({ ...query, id: 'bad' }), null);
  assert.deepEqual(
    restoreQuery({ ...query, series: { '0123456789ab': { name: 'x' }, bad: {} } }).series,
    {
      '0123456789ab': { name: 'x' },
    },
  );
  assert.equal(featureValue('temperature', 21.456), 21.46);
  assert.equal(featureValue('number', null), null);
});

test('review fixes: yields, windows, empty statements, date columns, organization id', async () => {
  const head = '#datatype,string,long,double,string\r\n#group,false,false,false,true\r\n';
  // Two yield(): the result name is in #default; tables restart at 0.
  const yields =
    `${head}#default,min,,,\r\n,result,table,_value,room\r\n,,0,1,a\r\n\r\n` +
    `${head}#default,max,,,\r\n,result,table,_value,room\r\n,,0,9,a\r\n`;
  assert.deepEqual(
    parseFlux(yields).series.map((entry) => [entry.labels._result, entry.value]),
    [
      ['min', 1],
      ['max', 9],
    ],
  );
  // window() without aggregate: one table per window, the latest wins.
  const windows = `${head}#default,_result,,,\r\n,result,table,_value,room\r\n,,0,1,a\r\n,,1,2,a\r\n`;
  assert.deepEqual(
    parseFlux(windows).series.map((entry) => entry.value),
    [2],
  );
  // A statement without data does not change the identity of the other one.
  const both = parseInfluxql(body('influxql-two-statements')).series[0].key;
  const one = JSON.parse(body('influxql-two-statements'));
  delete one.results[1].series;
  assert.equal(parseInfluxql(JSON.stringify(one)).series[0].key, both);
  // A date as text (date_bin() AS bucket) does not make a series per row.
  const sql = JSON.stringify([
    { bucket: '2026-10-20T10:00:00', value: 2 },
    { bucket: '2026-10-20T09:00:00', value: 1 },
  ]);
  assert.deepEqual(values(parseSql(sql)), { Q: 2 });
  // The answer of InfluxDB 2.9.1 to an unknown orgID.
  const unknownId = clientWith('v2', 'flux-org-not-found', {
    request: async () => ({
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"code":"invalid","message":"failed to decode request body: organization not found"}',
    }),
  });
  await assert.rejects(unknownId.query('q'), { kind: ERROR_KINDS.ORGANIZATION });
});
