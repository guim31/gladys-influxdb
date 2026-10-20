// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from the real
// answers of InfluxDB (test/fixtures/real): a query of every type in each of
// the three query languages, several series, a single value, in every
// feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { QUERY_TYPE_KEYS } from '../src/queries.js';
import { CONFIGS, QUERIES, addQuery, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

// Every API, one query per type (the real answers of each), and a query
// whose series share a name.
const ANSWERING = {
  v1: Object.keys(QUERIES.v1)
    .slice(0, 5)
    .filter((text) => !text.includes('label')),
  v2: Object.keys(QUERIES.v2).filter((text) => !text.includes('nobucket') && !text.endsWith('(')),
  v3: Object.keys(QUERIES.v3).slice(0, 3),
};

async function discover(language) {
  const devices = [];
  for (const [api, texts] of Object.entries(ANSWERING)) {
    const world = await createWorld({ config: { ...CONFIGS[api], language } });
    for (const [index, type] of QUERY_TYPE_KEYS.entries()) {
      await addQuery(world, { name: `${api} ${type}`, query: texts[index % texts.length], type });
    }
    await addQuery(world, { name: `${api} same names`, query: texts[0], label: 'nothing' });
    await world.app.stop();
    devices.push(...world.fake.discoveredDevices);
  }
  return devices;
}

const scenarios = ['en', 'fr', 'de', 'es'].map((language) => ({
  label: `${language} names`,
  language,
}));

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const devices = await discover(scenario.language);
    assert.equal(devices.length, 3 * (QUERY_TYPE_KEYS.length + 1), 'every query of every API');
    assert.ok(
      devices.every((device) => device.features.length > 0),
      'every device has features',
    );
    assert.equal(
      new Set(devices.map((device) => device.external_id)).size,
      devices.length,
      'unique device external ids',
    );

    for (const device of devices) {
      const where = device.name;

      // should_poll: true if and only if poll_frequency is provided, in ms.
      if (device.poll_frequency === undefined) {
        assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
      } else {
        assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
        assert.ok(
          table.poll_frequencies_ms.includes(device.poll_frequency),
          `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
        );
      }

      assert.ok(device.features.length > 0, `${where}: no feature`);
      const externalIds = new Set();
      const names = new Set();
      for (const feature of device.features) {
        const at = `${where} / ${feature.name}`;
        const pair = table.pairs[`${feature.category}/${feature.type}`];
        assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
        assert.ok(
          pair.label_en && pair.label_fr && pair.icon,
          `${at}: couple without label or icon`,
        );

        assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
        assert.ok(
          Number.isFinite(feature.min) && Number.isFinite(feature.max),
          `${at}: finite min/max`,
        );
        assert.ok(feature.min <= feature.max, `${at}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
        assert.equal(
          typeof feature.has_feedback,
          'boolean',
          `${at}: has_feedback must be a boolean`,
        );
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
        }

        assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
        externalIds.add(feature.external_id);
        assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
        names.add(feature.name);
      }
    }
  });
}
