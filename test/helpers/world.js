// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake InfluxDB, a temporary
// /data and a manual clock, with the integration wired on top through
// registerHandlers. No timer runs: the tests read with `world.hub.pollAll()`.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { queryIds } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import {
  FakeInflux,
  INFLUX3_URL,
  INFLUX_URL,
  QUERIES,
  ROOMS,
  TOKEN,
  fixtures,
  influxqlAnswer,
} from './fakeInflux.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

// One configuration per API, as a user would type it.
export const CONFIGS = {
  v1: {
    api_version: 'v1',
    url: '192.0.2.20',
    database: 'sensors',
    username: 'reader',
    password: 'secret',
    language: 'en',
  },
  v2: {
    api_version: 'v2',
    url: 'http://192.0.2.20:8086/orgs/0123456789abcdef/data-explorer',
    organization: 'home',
    token: ` ${TOKEN}\n`,
    language: 'en',
  },
  v3: {
    api_version: 'v3',
    url: '192.0.2.20',
    database: 'sensors',
    token: TOKEN,
    language: 'en',
  },
};
export const BASE_CONFIG = CONFIGS.v1;

/** A manual clock, shared by the hub and the tests. */
export function createClock(start = Date.parse('2026-10-20T10:00:00Z')) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

export async function createWorld({
  clock = createClock(),
  config = BASE_CONFIG,
  influx = new FakeInflux(config.api_version ?? 'v2'),
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-influxdb-')),
  timings = {},
  timers = false,
} = {}) {
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: (url, options) => {
      if (![INFLUX_URL, INFLUX3_URL].includes(new URL(url).origin)) {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      }
      return influx.request(url, options);
    },
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, influx, app, hub: app.hub, clock, dataDir };
}

export const queryDevice = (gladys, id) => queryIds(gladys, id).device;

/** Add discovered devices in Gladys, as the user would (all by default). */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
}

/** Add a query through the configuration action; its message in English. */
export async function addQuery(world, fields) {
  const ack = await world.fake.action('add_query', fields);
  if (!ack.success) {
    throw new Error(ack.error);
  }
  return ack.data?.message?.en ?? ack.data?.message ?? ack.data;
}

export { FakeInflux, INFLUX3_URL, INFLUX_URL, QUERIES, ROOMS, TOKEN, fixtures, influxqlAnswer };
