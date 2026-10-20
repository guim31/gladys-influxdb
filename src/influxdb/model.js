// -----------------------------------------------------------------------------
// From the query answers to plain series { key, labels, value }, without I/O.
// A series is what becomes a feature of the query device; its identity is
// its labels (tags, measurement, field), sorted and hashed, so that it stays
// the same from one read to the next.
//
//   - Flux (annotated CSV): one series per table, labelled by its group key
//     without `_start` and `_stop` (they move at every read); the value is
//     `_value` of the last row, or, without `_value` (after a pivot()), every
//     numeric column outside the group key, each its own series (`_field`).
//   - InfluxQL (JSON): one series per series of the answer, labelled by its
//     measurement (`_measurement`) and tags; the value is the last row; with
//     several value columns (`SELECT last(a), last(b)`), one series per
//     column (`_field`).
//   - SQL (JSON rows): the text columns label the series, every numeric or
//     boolean column is a value (one series per column when there are
//     several); the first row of a series wins (`ORDER BY time DESC`).
//
// Booleans count as 1 and 0; text values are left out. An answer with rows
// but no number at all is an error (`not_number`).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

const hash = (text, length) => createHash('sha256').update(text).digest('hex').slice(0, length);

export const RESULT_ERRORS = Object.freeze({
  NOT_NUMBER: 'not_number', // rows, but no numeric value
  BAD_ANSWER: 'bad_answer', // an answer that does not parse
});

// Flux columns that never label a series.
const FLUX_SYSTEM = new Set(['', 'result', 'table', '_start', '_stop', '_time']);
const FLUX_NUMBERS = new Set(['double', 'long', 'unsignedLong', 'boolean']);

/** Labels sorted by code point: they make ids, they must not depend on a locale. */
const sortedLabels = (labels) =>
  Object.fromEntries(
    Object.entries(labels)
      .filter(([, value]) => typeof value === 'string')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** The identity of a series: its sorted labels, hashed. Stable across reads. */
export const seriesKey = (labels) => hash(JSON.stringify(sortedLabels(labels)), 12);

/** A number, a boolean, a numeric text → a finite number, or null. */
export function parseSample(raw) {
  if (raw === true || raw === 'true') {
    return 1;
  }
  if (raw === false || raw === 'false') {
    return 0;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** One CSV line → cells (RFC 4180 quotes; the CSV of Flux quotes when needed). */
function csvCells(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

/** CSV text → lines of cells; a quoted cell may hold a line break. */
function csvLines(text) {
  const lines = [];
  let current = '';
  let quotes = 0;
  for (const raw of text.split(/\r?\n/)) {
    current = current ? `${current}\n${raw}` : raw;
    quotes += (raw.match(/"/g) ?? []).length;
    if (quotes % 2 === 0) {
      lines.push(current);
      current = '';
      quotes = 0;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

/**
 * The tables of an annotated CSV answer of Flux.
 * @returns {Array<{ columns: string[], types: string[], group: boolean[], rows: string[][] }>}
 */
export function parseFluxCsv(text) {
  const tables = [];
  let annotations = {};
  let table = null;
  for (const line of csvLines(typeof text === 'string' ? text : '')) {
    if (line.trim() === '') {
      table = null;
      annotations = {};
      continue;
    }
    const cells = csvCells(line);
    if (cells[0].startsWith('#')) {
      annotations[cells[0]] = cells;
      table = null;
      continue;
    }
    if (!table) {
      // The header of a new table (a new schema: new annotations before it).
      table = {
        columns: cells,
        types: annotations['#datatype'] ?? [],
        group: (annotations['#group'] ?? []).map((cell) => cell === 'true'),
        rows: [],
      };
      tables.push(table);
      continue;
    }
    table.rows.push(cells);
  }
  return tables;
}

/**
 * Series of a Flux answer.
 * @returns {{ series: Array<{ key: string, labels: object, value: number|null }>, error?: string, detail?: string }}
 */
export function parseFlux(text) {
  const byTable = new Map();
  let rows = 0;
  for (const table of parseFluxCsv(text)) {
    const { columns, types, group } = table;
    // An error in the stream, after the 200 (a failure during the execution).
    if (columns.includes('error') && columns.includes('reference')) {
      const detail = table.rows[0]?.[columns.indexOf('error')] ?? '';
      return { series: [], error: 'stream', detail: detail.slice(0, 300) };
    }
    const at = (name) => columns.indexOf(name);
    const tableIndex = at('table');
    const valueIndex = at('_value');
    const labelColumns = columns
      .map((name, index) => ({ name, index }))
      .filter(({ name, index }) => group[index] && !FLUX_SYSTEM.has(name));
    const valueColumns =
      valueIndex >= 0
        ? [{ name: '_value', index: valueIndex }]
        : columns
            .map((name, index) => ({ name, index }))
            .filter(
              ({ name, index }) =>
                !group[index] && !FLUX_SYSTEM.has(name) && FLUX_NUMBERS.has(types[index]),
            );
    for (const row of table.rows) {
      rows += 1;
      const labels = Object.fromEntries(labelColumns.map(({ name, index }) => [name, row[index]]));
      const result = row[at('result')];
      if (result && result !== '_result') {
        labels._result = result; // several yield() in one script
      }
      for (const { name, index } of valueColumns) {
        if (!FLUX_NUMBERS.has(types[index])) {
          continue; // a text _value
        }
        const named = valueIndex >= 0 ? labels : { ...labels, _field: name };
        const id = `${row[tableIndex]}|${result}|${name}`;
        // The last row of a table wins: Flux sorts by time.
        byTable.set(id, { labels: named, value: parseSample(row[index]) });
      }
    }
  }
  return finish([...byTable.values()], rows);
}

/** Series of an InfluxQL answer (`/query`, JSON). */
export function parseInfluxql(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { series: [], error: RESULT_ERRORS.BAD_ANSWER };
  }
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const statements = results.filter((result) => Array.isArray(result?.series)).length;
  const found = [];
  let rows = 0;
  for (const result of results) {
    for (const entry of Array.isArray(result?.series) ? result.series : []) {
      const columns = Array.isArray(entry?.columns) ? entry.columns : [];
      const values = Array.isArray(entry?.values) ? entry.values : [];
      const last = values.at(-1);
      if (!Array.isArray(last)) {
        continue;
      }
      rows += values.length;
      const labels = { _measurement: String(entry.name ?? ''), ...(entry.tags ?? {}) };
      if (statements > 1) {
        labels._statement = String(result.statement_id ?? 0);
      }
      const valueColumns = columns
        .map((name, index) => ({ name, index }))
        .filter(({ name }) => name !== 'time');
      for (const { name, index } of valueColumns) {
        const value = parseSample(last[index]);
        if (value === null && typeof last[index] === 'string') {
          continue; // a text field
        }
        found.push({
          labels: valueColumns.length > 1 ? { ...labels, _field: name } : labels,
          value,
        });
      }
    }
  }
  return finish(found, rows);
}

/** Series of an SQL answer (`/api/v3/query_sql`, JSON rows). */
export function parseSql(text) {
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return { series: [], error: RESULT_ERRORS.BAD_ANSWER };
  }
  if (!Array.isArray(rows)) {
    return { series: [], error: RESULT_ERRORS.BAD_ANSWER };
  }
  const isValue = (raw) => typeof raw === 'number' || typeof raw === 'boolean';
  const valueNames = [
    ...new Set(
      rows.flatMap((row) =>
        Object.entries(row ?? {})
          .filter(([name, raw]) => name !== 'time' && isValue(raw))
          .map(([name]) => name),
      ),
    ),
  ];
  const byKey = new Map();
  for (const row of rows) {
    const labels = Object.fromEntries(
      Object.entries(row ?? {}).filter(
        ([name, raw]) => name !== 'time' && typeof raw === 'string' && !valueNames.includes(name),
      ),
    );
    for (const name of valueNames) {
      if (!(name in (row ?? {}))) {
        continue;
      }
      const named = valueNames.length > 1 ? { ...labels, _field: name } : labels;
      const key = seriesKey(named);
      if (!byKey.has(key)) {
        byKey.set(key, { labels: named, value: parseSample(row[name]) });
      }
    }
  }
  return finish([...byKey.values()], rows.length);
}

/** Keys, duplicates merged (the first wins), and the "no number" error. */
function finish(found, rows) {
  const seen = new Map();
  for (const { labels, value } of found) {
    const clean = sortedLabels(labels);
    const key = seriesKey(clean);
    if (!seen.has(key)) {
      seen.set(key, { key, labels: clean, value });
    }
  }
  const series = [...seen.values()];
  if (series.length === 0 && rows > 0) {
    return { series, error: RESULT_ERRORS.NOT_NUMBER };
  }
  return { series };
}

const PARSERS = { flux: parseFlux, influxql: parseInfluxql, sql: parseSql };

/** The series of an answer of InfluxClient.query(). */
export const parseAnswer = ({ format, body }) => PARSERS[format](body);

// The labels that name a series best, when several are worth showing.
const PREFERRED_LABELS = [
  'room',
  'host',
  'name',
  'friendly_name',
  'entity_id',
  'device',
  'location',
  'sensor',
  '_field',
  '_measurement',
];

/**
 * The name of each series of a query: the value of the chosen label, or of
 * the labels that differ from one series to the other; the query name for a
 * single series.
 * @param {Array<{ key: string, labels: Record<string, string> }>} series
 * @param {string} queryName
 * @param {string} [label] the label chosen by the user, '' for automatic
 * @returns {Map<string, string>} series key → name
 */
export function seriesNames(series, queryName, label = '') {
  const names = new Map();
  if (series.length === 0) {
    return names;
  }
  let varying = [];
  if (!label) {
    const all = [...new Set(series.flatMap((entry) => Object.keys(entry.labels)))];
    const rank = (name) =>
      PREFERRED_LABELS.includes(name) ? PREFERRED_LABELS.indexOf(name) : PREFERRED_LABELS.length;
    varying = all
      .filter((name) => new Set(series.map((entry) => entry.labels[name] ?? '')).size > 1)
      .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 2);
  }
  for (const entry of series) {
    const parts = label
      ? [entry.labels[label]].filter(Boolean)
      : varying.map((name) => entry.labels[name]).filter(Boolean);
    names.set(entry.key, parts.length > 0 ? parts.join(' ') : queryName);
  }
  return names;
}
