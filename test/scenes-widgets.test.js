// The scene action "Read an InfluxDB value" and the widget "InfluxDB values",
// against the fake InfluxDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { formatValue } from '../src/widgets.js';
import { CONFIGS, ROOMS, addQuery, createDevices, createWorld } from './helpers/world.js';

async function world(t, options = {}) {
  const created = await createWorld(options);
  t.after(() => created.app.stop());
  return created;
}

const contentOf = async (w, settings = {}, language = 'en') => {
  const ack = await w.fake.widgetGet('values', { settings, language });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
};

test('"Read an InfluxDB value": first value, count, text; errors in words', async (t) => {
  const w = await world(t);
  const rooms = await w.fake.sceneAction('query_value', { query: ROOMS.v1 });
  assert.deepEqual(rooms.data.outputs, {
    value: 15.75,
    series: 3,
    text: 'attic: 15.75, bedroom: 19.25, kitchen: 21.5',
  });
  const mean = await w.fake.sceneAction('query_value', {
    query: 'SELECT mean(value) FROM temperature',
  });
  assert.deepEqual(mean.data.outputs, { value: 18.83, series: 1, text: '18.83' });
  const empty = await w.fake.sceneAction('query_value', { query: 'SELECT value FROM nothing' });
  assert.deepEqual(empty.data.outputs, { value: 0, series: 0, text: '' });

  const bad = await w.fake.sceneAction('query_value', { query: 'SELEC value FROM temperature' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /^query refused by InfluxDB: error parsing query/);
  const text = await w.fake.sceneAction('query_value', { query: 'SELECT last(label) FROM state' });
  assert.equal(text.error, 'the result has no number (text only)');
  const none = await w.fake.sceneAction('query_value', { query: ' ' });
  assert.equal(none.error, 'Enter a query.');
  w.influx.failure = 'down';
  const down = await w.fake.sceneAction('query_value', { query: ROOMS.v1 });
  assert.equal(down.error, 'does not answer');
});

test('"Read an InfluxDB value" in Flux and SQL, and without server', async (t) => {
  const flux = await world(t, { config: { ...CONFIGS.v2, language: 'fr' } });
  const fluxAck = await flux.fake.sceneAction('query_value', { query: ROOMS.v2 });
  assert.equal(fluxAck.data.outputs.series, 3);
  assert.match(fluxAck.data.outputs.text, /kitchen 0 : 21\.5/);
  const sql = await world(t, { config: CONFIGS.v3 });
  const sqlAck = await sql.fake.sceneAction('query_value', { query: ROOMS.v3 });
  assert.equal(sqlAck.data.outputs.series, 3);
  const none = await world(t, { config: { language: 'de' } });
  const refused = await none.fake.sceneAction('query_value', { query: 'x' });
  assert.equal(refused.error, 'Es ist keine InfluxDB konfiguriert.');
});

test('the widget: one row per series with its unit, an error row, a valid content', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Rooms', query: ROOMS.v1, type: 'temperature' });
  await addQuery(w, { name: 'Mean', query: 'SELECT mean(value) FROM temperature' });
  await addQuery(w, { name: 'Broken', query: 'SELECT last(value) FROM broken' });
  w.influx.answers['SELECT last(value) FROM broken'] =
    w.influx.answers['SELEC value FROM temperature'];
  await w.hub.pollAll();
  const content = await contentOf(w, {}, 'fr');
  assert.deepEqual(validateWidgetContent(content), []);
  const [status, button] = content.components;
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value]),
    [
      ['Broken', 'Erreur'],
      ['Mean', '18,83'],
      ['Rooms · attic', '15,75 °C'],
      ['Rooms · bedroom', '19,25 °C'],
      ['Rooms · kitchen', '21,5 °C'],
    ],
  );
  assert.equal(button.action.key, 'refresh');
  assert.equal(button.label, 'Actualiser');
  const refreshed = await w.fake.widgetAction('values', 'refresh', {});
  assert.equal(refreshed.success, true, refreshed.error);
  assert.equal(refreshed.data.message.en, 'Values read again.');
});

test('the widget shows the chosen queries only, and ten rows at most', async (t) => {
  const w = await world(t);
  await addQuery(w, { name: 'Rooms', query: ROOMS.v1, type: 'temperature' });
  await addQuery(w, { name: 'Mean', query: 'SELECT mean(value) FROM temperature' });
  await createDevices(w);
  const rooms = w.fake.discoveredDevices.find((device) => device.name === 'Rooms');
  const chosen = await contentOf(w, { queries: [rooms.external_id] });
  assert.equal(chosen.components[0].items.length, 3);
  const gone = await contentOf(w, { queries: ['influxdb:query:000000000000'] });
  assert.equal(gone.components[0].type, 'button', 'a removed query shows nothing');

  for (let index = 0; index < 4; index += 1) {
    await addQuery(w, { name: `Rooms ${index}`, query: ROOMS.v1 });
  }
  const { items } = (await contentOf(w)).components[0];
  assert.equal(items.length, 10);
  assert.deepEqual(items.at(-1), {
    label: 'Others',
    value: '+7',
    icon: 'more-horizontal',
    color: 'neutral',
  });
});

test('the widget says what to do first, and when the server does not answer', async (t) => {
  const none = await world(t, { config: { language: 'en' } });
  assert.match((await contentOf(none)).components[0].text, /Enter the address of your InfluxDB/);
  const empty = await world(t);
  assert.match((await contentOf(empty)).components[0].text, /^No query yet/);
  await addQuery(empty, { name: 'Rooms', query: ROOMS.v1 });
  empty.influx.failure = 'down';
  await empty.hub.pollAll();
  const down = await contentOf(empty);
  assert.equal(down.components[0].text, 'InfluxDB: does not answer');
  assert.deepEqual(validateWidgetContent(down), []);
});

test('values are written with the decimal separator of the language', () => {
  assert.match(formatValue('energy', 1234.567, 'fr'), /^1\s234,57 kWh$/);
  assert.equal(formatValue('power', -250, 'en'), '-250 W');
  assert.equal(formatValue('humidity', 48.2, 'de'), '48,2 %');
});
