// -----------------------------------------------------------------------------
// The InfluxDB queries followed as Gladys devices, added and removed with the
// configuration actions "Add a query" and "Remove a query" (Gladys has no list
// field in a configuration form), stored under /data (src/store.js).
//
// A query = a name (its identity: the device external id is derived from it),
// a query text in the language of the configured API (Flux, InfluxQL or SQL),
// a Gladys type (category, type, unit, display bounds of its features) and
// optionally the label (tag) that names its series.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as CATEGORY,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
} from '@gladysassistant/integration-sdk';

// Queries at most, and series (features) per query at most: Gladys accepts
// 300 states per minute, and a dashboard of 200 features helps nobody.
export const MAX_QUERIES = 20;
export const MAX_SERIES = 20;
export const MAX_NAME_LENGTH = 60;
export const MAX_QUERY_LENGTH = 4000;
export const MAX_LABEL_LENGTH = 64;

const BIG = 1e12;

// The types offered in "Add a query": keys stored under /data and in the
// feature external ids, permanent once published. Bounds are display bounds.
export const QUERY_TYPES = Object.freeze({
  number: { category: CATEGORY.UNKNOWN, type: TYPE.UNKNOWN.UNKNOWN, min: -BIG, max: BIG },
  temperature: {
    category: CATEGORY.TEMPERATURE_SENSOR,
    type: TYPE.SENSOR.DECIMAL,
    unit: UNIT.CELSIUS,
    min: -100,
    max: 200,
  },
  humidity: {
    category: CATEGORY.HUMIDITY_SENSOR,
    type: TYPE.SENSOR.DECIMAL,
    unit: UNIT.PERCENT,
    min: 0,
    max: 100,
  },
  percent: {
    category: CATEGORY.LEVEL_SENSOR,
    type: TYPE.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
    unit: UNIT.PERCENT,
    min: 0,
    max: 100,
  },
  power: {
    category: CATEGORY.ENERGY_SENSOR,
    type: TYPE.ENERGY_SENSOR.POWER,
    unit: UNIT.WATT,
    // Signed: a solar inverter exports.
    min: -1e6,
    max: 1e6,
  },
  energy: {
    category: CATEGORY.ENERGY_SENSOR,
    type: TYPE.ENERGY_SENSOR.ENERGY,
    unit: UNIT.KILOWATT_HOUR,
    min: 0,
    max: BIG,
  },
});

export const QUERY_TYPE_KEYS = Object.keys(QUERY_TYPES);

/** The id of a query: its name, case and spaces aside, hashed. */
export const queryId = (name) =>
  createHash('sha256')
    .update(name.trim().replace(/\s+/g, ' ').toLowerCase())
    .digest('hex')
    .slice(0, 12);

/** The value published for a sample of this type (null: nothing to publish). */
export function featureValue(type, value) {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  // Two decimals: enough for a dashboard, and fewer states for a noisy value.
  return Math.round(value * 100) / 100;
}

export const QUERY_ERRORS = Object.freeze({
  NAME: 'name',
  QUERY: 'query',
  TYPE: 'type',
  LABEL: 'label',
});

/**
 * The fields of "Add a query", checked.
 * @returns {{ query?: object, error?: string }}
 */
export function parseQueryFields(fields = {}) {
  const text = (key) =>
    typeof fields[key] === 'string' ? fields[key].trim().replace(/\s+/g, ' ') : '';
  const name = text('name');
  if (!name || name.length > MAX_NAME_LENGTH) {
    return { error: QUERY_ERRORS.NAME };
  }
  const query = typeof fields.query === 'string' ? fields.query.trim() : '';
  if (!query || query.length > MAX_QUERY_LENGTH) {
    return { error: QUERY_ERRORS.QUERY };
  }
  const type = typeof fields.type === 'string' && fields.type ? fields.type : 'number';
  if (!QUERY_TYPE_KEYS.includes(type)) {
    return { error: QUERY_ERRORS.TYPE };
  }
  const label = text('label');
  if (label.length > MAX_LABEL_LENGTH) {
    return { error: QUERY_ERRORS.LABEL };
  }
  return { query: { id: queryId(name), name, query, type, label } };
}

/** A query read back from /data, or null when it is not one. */
export function restoreQuery(saved) {
  if (!saved || typeof saved !== 'object') {
    return null;
  }
  const { query } = parseQueryFields(saved);
  if (!query || query.id !== saved.id) {
    return null;
  }
  const series = {};
  for (const [key, entry] of Object.entries(saved.series ?? {})) {
    if (/^[0-9a-f]{12}$/.test(key) && typeof entry?.name === 'string') {
      series[key] = { name: entry.name };
    }
  }
  return { ...query, series };
}
