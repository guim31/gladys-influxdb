// The hub against the fake InfluxDB: queries added and removed in the three
// languages, discovery, states of the added devices only, scene events
// (server unreachable and back, a query that fails, kept across a
// restart), errors, heartbeat, the reading timer, and quiet logs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQueryId, queryIds, seriesFeatureKey } from '../src/devices.js';
import { TRIGGERS } from '../src/hub.js';
import { seriesKey } from '../src/influxdb/model.js';
import { queryId } from '../src/queries.js';
import {
  CONFIGS,
  FakeInflux,
  ROOMS,
  addQuery,
  createClock,
  createDevices,
  createWorld,
  fixtures,
  influxqlAnswer,
} from './helpers/world.js';

/** The lines written at `LOG_LEVEL=info` from now on (the SDK logger reads it per line). */
function captureLogs(t) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const lines = [];
  for (const stream of ['log', 'error']) {
    t.mock.method(console, stream, (...args) => lines.push(args.join(' ')));
  }
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}

async function world(t, options = {}) {
  const created = await createWorld(options);
  t.after(() => created.app.stop());
  return created;
}

const featureOf = (w, name, type, labels) =>
  queryIds(w.gladys, queryId(name)).feature(seriesFeatureKey(type, seriesKey(labels)));
const transportOf = (w, externalId) =>
  w.fake.transports.filter((entry) => entry.device_external_id === externalId).at(-1)?.transport;

for (const api of ['v1', 'v2', 'v3']) {
  test(`${api}: a query gives one feature per room, with its state once added`, async (t) => {
    const w = await world(t, { config: CONFIGS[api] });
    assert.deepEqual(w.fake.connectionStatus, { connected: true });
    assert.deepEqual(w.fake.discoveredDevices, [], 'no query, no device');
    const message = await addQuery(w, { name: 'Rooms', query: ROOMS[api], type: 'temperature' });
    assert.equal(message, 'Query "Rooms" added, 3 series, add its device from the Discover tab.');
    const [device] = w.fake.discoveredDevices;
    assert.equal(parseQueryId(w.gladys, device.external_id), queryId('Rooms'));
    assert.equal(device.should_poll, false);
    assert.deepEqual(
      device.features.map((feature) => [
        feature.name.split(' ')[0],
        feature.category,
        feature.unit,
      ]),
      [
        ['attic', 'temperature-sensor', 'celsius'],
        ['bedroom', 'temperature-sensor', 'celsius'],
        ['kitchen', 'temperature-sensor', 'celsius'],
      ],
    );
    assert.equal(w.fake.states.length, 0, 'nothing for a device not added');
    await createDevices(w);
    const kitchen = device.features.find((feature) => feature.name.startsWith('kitchen'));
    assert.equal(w.fake.lastState(kitchen.external_id), 21.5);
    assert.equal(transportOf(w, device.external_id), 'local');
  });
}

test('the requests: token, organization, database, as each API wants them', async (t) => {
  const v2 = await world(t, { config: CONFIGS.v2 });
  await addQuery(v2, { name: 'Rooms', query: ROOMS.v2 });
  const flux = v2.influx.calls.find((call) => call.path.startsWith('/api/v2/query'));
  assert.equal(flux.path, '/api/v2/query?org=home');
  assert.equal(flux.headers.authorization, 'Token test-token', 'trimmed');
  assert.deepEqual(JSON.parse(flux.body).dialect.annotations, ['datatype', 'group', 'default']);

  // The organization id of the address, when the field is empty.
  const byId = await world(t, { config: { ...CONFIGS.v2, organization: '' } });
  await addQuery(byId, { name: 'Rooms', query: ROOMS.v2 });
  assert.ok(byId.influx.calls.some((call) => call.path === '/api/v2/query?orgID=0123456789abcdef'));

  const v3 = await world(t, { config: CONFIGS.v3 });
  await addQuery(v3, { name: 'Rooms', query: ROOMS.v3 });
  const sql = v3.influx.calls.find((call) => call.path.startsWith('/api/v3/query_sql'));
  assert.equal(sql.headers.authorization, 'Bearer test-token');
  assert.match(sql.path, /db=sensors.*format=json/);
  assert.equal(v3.influx.calls[0].path, '/ping', 'the address got :8181');
});

test('InfluxQL with a token: the v1 compatibility API of InfluxDB 2 and 3', async (t) => {
  const influx = new FakeInflux('v3');
  influx.answers['SELECT last(value) FROM temperature GROUP BY room'] = fixtures['influxql-v3'];
  const w = await world(t, {
    influx,
    config: {
      ...CONFIGS.v1,
      url: '192.0.2.20:8181',
      username: '',
      password: '',
      token: 'test-token',
    },
  });
  await addQuery(w, { name: 'Rooms', query: 'SELECT last(value) FROM temperature GROUP BY room' });
  assert.ok(influx.calls.some((call) => call.headers.authorization === 'Token test-token'));
  assert.equal(w.fake.discoveredDevices[0].features.length, 3);
});

test('a refused query is answered, not saved; text only too', async (t) => {
  const w = await world(t);
  const ack = await w.fake.action('add_query', {
    name: 'Bad',
    query: 'SELEC value FROM temperature',
  });
  assert.equal(ack.success, true);
  assert.match(
    ack.data.message.en,
    /^InfluxDB refuses this query: error parsing query: found SELEC, expected SELECT/,
  );
  assert.match(ack.data.message.fr, /^InfluxDB refuse cette requête : error parsing query/);
  const text = await w.fake.action('add_query', {
    name: 'Text',
    query: 'SELECT last(label) FROM state',
  });
  assert.equal(
    text.data.message.en,
    'InfluxDB refuses this query: the result has no number (text only)',
  );
  assert.equal(w.hub.queries.size, 0);
  const empty = await w.fake.action('add_query', { name: '', query: 'x' });
  assert.equal(empty.data.message.de, 'Gib der Abfrage einen Namen (höchstens 60 Zeichen).');
});

test('a query with no data for now is kept; its series come later', async (t) => {
  const w = await world(t);
  const message = await addQuery(w, { name: 'Later', query: 'SELECT last(value) FROM soon' });
  assert.equal(
    message,
    'Query "Later" added, no data for now, add its device from the Discover tab.',
  );
  w.influx.setValue('SELECT last(value) FROM soon', 3, { host: 'a' });
  await w.hub.pollAll();
  assert.equal(w.fake.discoveredDevices[0].features[0].name, 'Later');
});

test('series met later get a feature, up to 20; a missing series keeps it', async (t) => {
  const w = await world(t);
  const text = 'SELECT last(power) FROM plugs GROUP BY plug';
  const plugs = (count) =>
    influxqlAnswer(
      'plugs',
      Array.from({ length: count }, (_, index) => ({
        tags: { plug: `p${index + 1}` },
        value: index,
      })),
    );
  w.influx.answers[text] = plugs(2);
  await addQuery(w, { name: 'Plugs', query: text, type: 'power' });
  await createDevices(w);
  w.influx.answers[text] = plugs(25);
  await w.hub.pollAll();
  const [device] = w.fake.discoveredDevices;
  assert.equal(device.features.length, 20);
  assert.equal(device.features[0].unit, 'watt');
  w.influx.answers[text] = plugs(1);
  await w.hub.pollAll();
  assert.equal(w.fake.discoveredDevices[0].features.length, 20, 'the features stay');
});

test('replacing a query keeps its device; another type gives new features', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Rooms', query: ROOMS.v1 });
  const before = w.fake.discoveredDevices[0];
  assert.match(
    await addQuery(w, { name: 'rooms ', query: ROOMS.v1, type: 'temperature' }),
    /updated/,
  );
  const after = w.fake.discoveredDevices[0];
  assert.equal(after.external_id, before.external_id);
  assert.equal(after.features.length, 3);
  assert.notEqual(after.features[0].external_id, before.features[0].external_id);
  assert.equal(
    after.features.find((feature) => feature.name === 'kitchen').external_id,
    featureOf(w, 'Rooms', 'temperature', { _measurement: 'temperature', room: 'kitchen' }),
  );
});

test('removing a query takes its device off the Discovery list', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Rooms', query: ROOMS.v1 });
  const ack = await w.fake.action('remove_query', { name: 'ROOMS' });
  assert.equal(ack.data.message.en, 'Query "Rooms" removed, 0 query(ies).');
  assert.deepEqual(w.fake.discoveredDevices, []);
  const missing = await w.fake.action('remove_query', { name: 'Nope' });
  assert.equal(missing.data.message.en, 'No query named "Nope".');
});

test('the queries are kept in /data across a restart', async (t) => {
  const first = await world(t);
  await addQuery(first, { name: 'Rooms', query: ROOMS.v1, label: 'room' });
  await first.app.stop();
  const second = await world(t, { dataDir: first.dataDir });
  assert.deepEqual(
    second.fake.discoveredDevices[0].features.map((feature) => feature.name),
    ['attic', 'bedroom', 'kitchen'],
  );
});

test('server unreachable after two failed reads, back once, the outage duration', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  await addQuery(w, { name: 'Rooms', query: ROOMS.v1 });
  await createDevices(w);
  const device = w.fake.discoveredDevices[0].external_id;
  w.influx.failure = 'down';
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [], 'one failed read is not an outage');
  assert.equal(w.fake.connectionStatus.message.en, 'InfluxDB: does not answer');
  assert.equal(w.fake.connectionStatus.message.fr, 'InfluxDB : ne répond pas');
  assert.equal(transportOf(w, device), 'unreachable');
  clock.advance(60_000);
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [
    { key: TRIGGERS.SERVER_DOWN, data: { error: 'does not answer', error_kind: 'unreachable' } },
  ]);
  clock.advance(14 * 60_000);
  w.influx.failure = null;
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents.slice(1), [
    { key: TRIGGERS.SERVER_UP, data: { duration_minutes: 14 } },
  ]);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.equal(transportOf(w, device), 'local');
});

test('an outage announced before a restart is ended after it', async (t) => {
  const first = await world(t);
  first.influx.failure = 'auth';
  await first.hub.pollAll();
  await first.hub.pollAll();
  assert.equal(first.fake.sceneEvents[0].data.error_kind, 'auth');
  await first.app.stop();
  const second = await world(t, { dataDir: first.dataDir });
  assert.deepEqual(
    second.fake.sceneEvents.map((event) => event.key),
    [TRIGGERS.SERVER_UP],
  );
});

test('a query that fails is announced once, again only after it worked', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Rooms', query: ROOMS.v1 });
  await addQuery(w, { name: 'Mean', query: 'SELECT mean(value) FROM temperature' });
  const good = w.influx.answers[ROOMS.v1];
  w.influx.answers[ROOMS.v1] = w.influx.answers['SELEC value FROM temperature'];
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 1);
  assert.equal(w.fake.sceneEvents[0].key, TRIGGERS.QUERY_FAILED);
  assert.equal(w.fake.sceneEvents[0].data.name, 'Rooms');
  assert.match(
    w.fake.sceneEvents[0].data.error,
    /^query refused by InfluxDB \(error parsing query/,
  );
  assert.deepEqual(w.fake.connectionStatus, { connected: true }, 'the server is fine');
  w.influx.answers[ROOMS.v1] = good;
  await w.hub.pollAll();
  w.influx.answers[ROOMS.v1] = w.influx.answers['SELEC value FROM temperature'];
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 2);
});

test('an unknown organization or database is a server error, told in the status', async (t) => {
  const org = await world(t, { config: { ...CONFIGS.v2, organization: 'nope' } });
  await addQuery(org, { name: 'Rooms', query: ROOMS.v2 });
  await org.hub.pollAll();
  assert.equal(
    org.fake.connectionStatus.message.en,
    'InfluxDB: organization not found: check its name',
  );
  const db = await world(t, { config: { ...CONFIGS.v1, database: 'nope' } });
  await addQuery(db, { name: 'Rooms', query: ROOMS.v1 });
  await db.hub.pollAll();
  assert.equal(db.fake.connectionStatus.message.en, 'InfluxDB: database not found: check its name');
  assert.deepEqual(
    db.fake.sceneEvents.filter((event) => event.key === TRIGGERS.QUERY_FAILED),
    [],
  );
});

test('configuration problems are told in the connection status', async (t) => {
  const none = await world(t, { config: { language: 'en' } });
  assert.match(none.fake.connectionStatus.message.en, /Enter the address of your InfluxDB/);
  const bad = await world(t, { config: { url: 'ftp://x', language: 'en' } });
  assert.match(bad.fake.connectionStatus.message.en, /Address not understood/);
  const noOrg = await world(t, { config: { url: '192.0.2.20', language: 'en' } });
  assert.match(noOrg.fake.connectionStatus.message.en, /InfluxDB 2 needs the organization/);
  const noDb = await world(t, { config: { ...CONFIGS.v3, database: '' } });
  assert.match(noDb.fake.connectionStatus.message.en, /SQL needs the database/);
  const ack = await noDb.fake.action('add_query', { name: 'A', query: 'SELECT 1' });
  assert.match(ack.data.message.en, /SQL needs the database/);
});

test('"Test the connection" sums up', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Nothing', query: 'SELECT value FROM nothing' });
  const ack = await w.fake.action('test_connection', {});
  assert.equal(ack.data.message.en, 'OK, InfluxDB 1.11.8, 1 query(ies), Nothing: no data for now.');
  w.influx.failure = 'html';
  const down = await w.fake.action('test_connection', {});
  assert.equal(
    down.data.message.en,
    'InfluxDB: no InfluxDB API of the chosen version at this address.',
  );
});

test('a device added later receives everything at once, and the widget is refreshed', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Rooms', query: ROOMS.v1 });
  const [rooms] = w.fake.discoveredDevices;
  await w.fake.deviceCreated(rooms);
  assert.equal(w.fake.lastState(rooms.features[2].external_id), 21.5);
  assert.ok(w.fake.widgetRefreshes.includes('values'));
  const count = w.fake.states.length;
  await w.fake.deviceUpdated(rooms);
  assert.ok(w.fake.states.length > count, '"Update" sends everything again');
});

test('only the changes are sent, and an unchanged value again after 6 hours', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  await addQuery(w, { name: 'Rooms', query: ROOMS.v1 });
  await createDevices(w);
  const count = w.fake.states.length;
  await w.hub.pollAll();
  assert.equal(w.fake.states.length, count);
  clock.advance(6 * 3600_000);
  await w.hub.pollAll();
  assert.equal(w.fake.states.length, count + 3);
});

test('while InfluxDB does not answer, no stale value is sent as a heartbeat', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  await addQuery(w, { name: 'Rooms', query: ROOMS.v1 });
  await createDevices(w);
  const count = w.fake.states.length;
  w.influx.failure = 'proxy';
  clock.advance(7 * 3600_000);
  await w.hub.pollAll();
  assert.equal(w.fake.states.length, count);
});

test('the timer of the container reads InfluxDB, without any onPoll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await world(t, { config: { ...CONFIGS.v1, poll_interval: '30' }, timers: true });
  const before = w.influx.calls.length;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  await w.hub.polling;
  assert.ok(w.influx.calls.length > before);
});

test('a normal reading cycle writes nothing at info level, and never a secret', async (t) => {
  const w = await world(t, { config: { ...CONFIGS.v1, password: 'secret' } });
  await addQuery(w, { name: 'Rooms', query: ROOMS.v1 });
  await createDevices(w);
  const lines = captureLogs(t);
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(lines, []);
  // A failure that repeats writes one line, and one when it is over.
  w.influx.failure = 'down';
  await w.hub.pollAll();
  await w.hub.pollAll();
  w.influx.failure = null;
  await w.hub.pollAll();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.ok(!lines.join('\n').includes('secret'));
});
