// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `values`.
//
// The use case: a glance at the measures InfluxDB already holds (the rooms
// of a Telegraf or Home Assistant setup, a solar inverter), without adding a
// device per query to the dashboard. One row per series — the value with its
// unit, or why the query has none — for every query, or the queries chosen
// in the widget settings (their devices).
//
// The figures are sent as values, not bound to device features: the widget
// works before any device is added.
//
// Budget (8 components, 2 texts): one text while the server does not
// answer, one status list of ten rows at most, and a Refresh button.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_UNITS as UNIT, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { parseQueryId } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { QUERY_TYPES, featureValue } from './queries.js';
import { pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 10;

export const TEXT = {
  configure: {
    en: 'Enter the address of your InfluxDB in the configuration of the integration.',
    fr: "Saisissez l'adresse de votre InfluxDB dans la configuration de l'intégration.",
    de: 'Gib die Adresse deiner InfluxDB in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de su InfluxDB en la configuración de la integración.',
  },
  noQuery: {
    en: 'No query yet: use "Add a query" in the configuration of the integration.',
    fr: "Aucune requête : utilisez « Ajouter une requête » dans la configuration de l'intégration.",
    de: 'Noch keine Abfrage: Nutze „Abfrage hinzufügen“ in der Konfiguration der Integration.',
    es: 'Ninguna consulta: use «Añadir una consulta» en la configuración de la integración.',
  },
  error: { en: 'Error', fr: 'Erreur', de: 'Fehler', es: 'Error' },
  noData: { en: 'No data', fr: 'Aucune donnée', de: 'Keine Daten', es: 'Sin datos' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otras' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Values read again.',
    fr: 'Valeurs relues.',
    de: 'Werte neu gelesen.',
    es: 'Valores leídos de nuevo.',
  },
};

const UNIT_SYMBOLS = {
  [UNIT.CELSIUS]: ' °C',
  [UNIT.PERCENT]: ' %',
  [UNIT.WATT]: ' W',
  [UNIT.KILOWATT_HOUR]: ' kWh',
};

const ICONS = {
  number: 'activity',
  temperature: 'thermometer',
  humidity: 'droplet',
  percent: 'percent',
  power: 'zap',
  energy: 'battery-charging',
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const refreshButton = (language) => ({
  type: 'button',
  label: pick(TEXT.refresh, language),
  icon: 'refresh-cw',
  style: 'secondary',
  action: { key: ACTIONS.REFRESH },
});

/** A value as shown: "21.5 °C", with the decimal separator of the language. */
export function formatValue(type, value, language) {
  const number = featureValue(type, value);
  const text = new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(number);
  return `${text}${UNIT_SYMBOLS[QUERY_TYPES[type].unit] ?? ''}`;
}

/** The queries the widget shows: the chosen devices, or every query. */
export function chosenQueries(hub, settings) {
  const chosen = [settings?.queries ?? []].flat().filter((id) => typeof id === 'string' && id);
  const all = [...hub.queries.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (chosen.length === 0) {
    return all;
  }
  // A chosen device whose query was removed shows nothing, not every query.
  const ids = new Set(chosen.map((id) => parseQueryId(hub.gladys, id) ?? id));
  return all.filter((query) => ids.has(query.id));
}

/** The rows of one query: a row per series, or one row saying why there is none. */
function queryRows(hub, query, language) {
  const result = hub.results.get(query.id);
  if (result?.error) {
    return [
      {
        label: fit(query.name, 40),
        value: pick(TEXT.error, language),
        icon: 'alert-triangle',
        color: WIDGET_COLORS.DANGER,
      },
    ];
  }
  const values = new Map((result?.series ?? []).map((entry) => [entry.key, entry.value]));
  const shown = Object.entries(query.series)
    .filter(([key]) => values.has(key) && featureValue(query.type, values.get(key)) !== null)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  if (shown.length === 0) {
    return [
      {
        label: fit(query.name, 40),
        value: pick(TEXT.noData, language),
        icon: 'minus-circle',
        color: WIDGET_COLORS.NEUTRAL,
      },
    ];
  }
  return shown.map(([key, entry]) => ({
    label: fit(
      shown.length === 1 || entry.name === query.name
        ? query.name
        : `${query.name} · ${entry.name}`,
      40,
    ),
    value: fit(formatValue(query.type, values.get(key), language), 40),
    icon: ICONS[query.type],
    color: WIDGET_COLORS.INFO,
  }));
}

async function get(hub, { settings, language = 'en' }) {
  if (!hub.client) {
    return {
      ttl_seconds: 300,
      components: [{ type: 'text', variant: 'body', text: pick(TEXT.configure, language) }],
    };
  }
  if (hub.queries.size === 0) {
    return {
      ttl_seconds: 300,
      components: [{ type: 'text', variant: 'body', text: pick(TEXT.noQuery, language) }],
    };
  }
  const components = [];
  const errorText = hub.errorText(language);
  if (errorText) {
    components.push({ type: 'text', variant: 'body', text: fit(errorText, 200) });
  }
  const rows = chosenQueries(hub, settings).flatMap((query) => queryRows(hub, query, language));
  if (rows.length > 0) {
    const items = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS - 1) : rows;
    if (rows.length > items.length) {
      items.push({
        label: pick(TEXT.more, language),
        value: `+${rows.length - items.length}`,
        icon: 'more-horizontal',
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
    components.push({ type: 'status', items });
  }
  components.push(refreshButton(language));
  const intervalSeconds = Math.round((hub.config?.pollIntervalMs ?? 60_000) / 1000);
  return { ttl_seconds: Math.min(300, Math.max(30, intervalSeconds)), components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  await hub.pollAll({ fresh: true });
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
