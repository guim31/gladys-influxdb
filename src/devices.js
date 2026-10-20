// -----------------------------------------------------------------------------
// Gladys devices, proposed in the Discovery tab (the user adds the ones to
// follow, nothing is created on their behalf): one device per InfluxDB query
// (src/queries.js), identity = the query name hashed; one feature per series
// the query has returned (MAX_SERIES at most), of the type chosen for the
// query, named after the series labels. A series that is missing at a read
// keeps its feature, without a new state.
//
// Published with should_poll: false: the integration reads InfluxDB on its
// own timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import { QUERY_TYPES, featureValue } from './queries.js';

export const QUERY_TYPE = 'query';

export const MODEL_QUERY = 'InfluxDB query';
export const PARAMS = Object.freeze({ QUERY: 'QUERY' });

export const queryIds = (gladys, id) => gladys.externalIds(QUERY_TYPE, id);

/** Feature key of a series: the type is part of it (a new type, new features). */
export const seriesFeatureKey = (type, seriesKey) => `${type}_${seriesKey}`;

/** The query id of a device external id, null when it is not a query of ours. */
export function parseQueryId(gladys, externalId) {
  const prefix = queryIds(gladys, '').device;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const id = externalId.slice(prefix.length);
  return /^[0-9a-f]{12}$/.test(id) ? id : null;
}

const readOnly = { read_only: true, has_feedback: false, keep_history: true };

/**
 * The discovery payload of a query: one feature per series seen.
 * @param {object} gladys SDK client
 * @param {{ id: string, name: string, query: string, type: string, series: Record<string, { name: string }> }} query
 */
export function buildQueryDevice(gladys, query) {
  const ids = queryIds(gladys, query.id);
  const spec = QUERY_TYPES[query.type];
  const features = Object.entries(query.series)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([key, entry]) => ({
      name: entry.name,
      external_id: ids.feature(seriesFeatureKey(query.type, key)),
      category: spec.category,
      type: spec.type,
      ...(spec.unit ? { unit: spec.unit } : {}),
      ...readOnly,
      min: spec.min,
      max: spec.max,
    }));
  return {
    name: query.name,
    external_id: ids.device,
    model: MODEL_QUERY,
    should_poll: false,
    params: [{ name: PARAMS.QUERY, value: query.query.slice(0, 255) }],
    features,
  };
}

/**
 * Feature values of a query (null: nothing to publish).
 * @param {Array<{ key: string, value: number|null }>} series the last result
 * @returns {Array<{ externalId: string, value: number|null }>}
 */
export function queryValues(gladys, query, series) {
  const ids = queryIds(gladys, query.id);
  return series
    .filter((entry) => query.series[entry.key])
    .map((entry) => ({
      externalId: ids.feature(seriesFeatureKey(query.type, entry.key)),
      value: featureValue(query.type, entry.value),
    }));
}
