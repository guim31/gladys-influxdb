// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the configuration action reports, scene event
// variables, scene action messages. Four languages, the four of the Gladys
// interface; German says "du", Spanish "usted". test/i18n.test.js checks
// every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './influxdb/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noServer: {
    en: 'Enter the address of your InfluxDB in the configuration.',
    fr: "Saisissez l'adresse de votre InfluxDB dans la configuration.",
    de: 'Gib die Adresse deiner InfluxDB in der Konfiguration ein.',
    es: 'Introduzca la dirección de su InfluxDB en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. http://192.168.1.2:8086',
    fr: 'Adresse incomprise, ex. http://192.168.1.2:8086',
    de: 'Adresse nicht verstanden, z. B. http://192.168.1.2:8086',
    es: 'Dirección no válida, p. ej. http://192.168.1.2:8086',
  },
  noOrganization: {
    en: 'InfluxDB 2 needs the organization: enter it in the configuration.',
    fr: "InfluxDB 2 demande l'organisation : saisissez-la dans la configuration.",
    de: 'InfluxDB 2 braucht die Organisation: Gib sie in der Konfiguration ein.',
    es: 'InfluxDB 2 necesita la organización: introdúzcala en la configuración.',
  },
  noDatabase: {
    en: 'SQL needs the database: enter it in the configuration.',
    fr: 'SQL demande la base de données : saisissez-la dans la configuration.',
    de: 'SQL braucht die Datenbank: Gib sie in der Konfiguration ein.',
    es: 'SQL necesita la base de datos: introdúzcala en la configuración.',
  },
};

// One short explanation per error kind (src/influxdb/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'does not answer',
    fr: 'ne répond pas',
    de: 'antwortet nicht',
    es: 'no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: tick "Accept self-signed certificates"',
    fr: 'certificat refusé : cochez « Accepter les certificats auto-signés »',
    de: 'Zertifikat abgelehnt: Aktiviere „Selbstsignierte Zertifikate akzeptieren“',
    es: 'certificado rechazado: marque «Aceptar certificados autofirmados»',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'access refused: check the token, or the user and password',
    fr: "accès refusé : vérifiez le jeton, ou l'utilisateur et le mot de passe",
    de: 'Zugriff verweigert: Prüfe das Token oder Benutzer und Passwort',
    es: 'acceso denegado: compruebe el token, o el usuario y la contraseña',
  },
  [ERROR_KINDS.NOT_INFLUX]: {
    en: 'no InfluxDB API of the chosen version at this address',
    fr: "pas d'API InfluxDB de la version choisie à cette adresse",
    de: 'keine InfluxDB-API der gewählten Version unter dieser Adresse',
    es: 'no hay ninguna API de InfluxDB de la versión elegida en esta dirección',
  },
  [ERROR_KINDS.REDIRECT]: {
    en: 'the address redirects: enter the https:// address',
    fr: "l'adresse redirige : saisissez l'adresse en https://",
    de: 'die Adresse leitet um: Gib die https://-Adresse ein',
    es: 'la dirección redirige: introduzca la dirección https://',
  },
  [ERROR_KINDS.ORGANIZATION]: {
    en: 'organization not found: check its name',
    fr: 'organisation introuvable : vérifiez son nom',
    de: 'Organisation nicht gefunden: Prüfe ihren Namen',
    es: 'organización no encontrada: compruebe su nombre',
  },
  [ERROR_KINDS.DATABASE]: {
    en: 'database not found: check its name',
    fr: 'base de données introuvable : vérifiez son nom',
    de: 'Datenbank nicht gefunden: Prüfe ihren Namen',
    es: 'base de datos no encontrada: compruebe su nombre',
  },
  [ERROR_KINDS.QUERY]: {
    en: 'query refused by InfluxDB',
    fr: 'requête refusée par InfluxDB',
    de: 'Abfrage von InfluxDB abgelehnt',
    es: 'consulta rechazada por InfluxDB',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// Why a query has no value (src/influxdb/model.js RESULT_ERRORS).
export const RESULT_TEXT = {
  not_number: {
    en: 'the result has no number (text only)',
    fr: "le résultat n'a aucun nombre (que du texte)",
    de: 'das Ergebnis hat keine Zahl (nur Text)',
    es: 'el resultado no tiene ningún número (solo texto)',
  },
  bad_answer: {
    en: 'answer not understood',
    fr: 'réponse incomprise',
    de: 'Antwort nicht verstanden',
    es: 'respuesta no comprendida',
  },
  empty: {
    en: 'no data for now',
    fr: 'aucune donnée pour le moment',
    de: 'im Moment keine Daten',
    es: 'ningún dato por ahora',
  },
};

// Reports of the configuration actions ("Test the connection", "Add a
// query", "Remove a query"). Functions: the parts that carry a value.
export const REPORT_TEXT = {
  en: {
    ok: 'OK',
    queries: (count) => `${count} query(ies)`,
    added: (name) => `Query "${name}" added`,
    updated: (name) => `Query "${name}" updated`,
    removed: (name) => `Query "${name}" removed`,
    series: (count) => `${count} series`,
    capped: (max) => `only the first ${max} are kept`,
    discovery: 'add its device from the Discover tab',
    notFound: (name) => `No query named "${name}".`,
    tooMany: (max) => `${max} queries at most: remove one first.`,
    refused: (detail) => `InfluxDB refuses this query: ${detail}`,
    notChecked: 'saved, but not checked',
    noQuery: 'no query yet: use "Add a query"',
  },
  fr: {
    ok: 'OK',
    queries: (count) => `${count} requête(s)`,
    added: (name) => `Requête « ${name} » ajoutée`,
    updated: (name) => `Requête « ${name} » modifiée`,
    removed: (name) => `Requête « ${name} » supprimée`,
    series: (count) => `${count} série(s)`,
    capped: (max) => `seules les ${max} premières sont gardées`,
    discovery: "ajoutez son appareil depuis l'onglet Découverte",
    notFound: (name) => `Aucune requête nommée « ${name} ».`,
    tooMany: (max) => `${max} requêtes au plus : supprimez-en une d'abord.`,
    refused: (detail) => `InfluxDB refuse cette requête : ${detail}`,
    notChecked: 'enregistrée, mais pas vérifiée',
    noQuery: 'aucune requête : utilisez « Ajouter une requête »',
  },
  de: {
    ok: 'OK',
    queries: (count) => `${count} Abfrage(n)`,
    added: (name) => `Abfrage „${name}“ hinzugefügt`,
    updated: (name) => `Abfrage „${name}“ geändert`,
    removed: (name) => `Abfrage „${name}“ entfernt`,
    series: (count) => `${count} Serie(n)`,
    capped: (max) => `nur die ersten ${max} werden behalten`,
    discovery: 'füge ihr Gerät im Tab „Entdecken“ hinzu',
    notFound: (name) => `Keine Abfrage namens „${name}“.`,
    tooMany: (max) => `Höchstens ${max} Abfragen: Entferne zuerst eine.`,
    refused: (detail) => `InfluxDB lehnt diese Abfrage ab: ${detail}`,
    notChecked: 'gespeichert, aber nicht geprüft',
    noQuery: 'noch keine Abfrage: Nutze „Abfrage hinzufügen“',
  },
  es: {
    ok: 'OK',
    queries: (count) => `${count} consulta(s)`,
    added: (name) => `Consulta «${name}» añadida`,
    updated: (name) => `Consulta «${name}» modificada`,
    removed: (name) => `Consulta «${name}» eliminada`,
    series: (count) => `${count} serie(s)`,
    capped: (max) => `solo se conservan las ${max} primeras`,
    discovery: 'añada su dispositivo desde la pestaña Descubrir',
    notFound: (name) => `Ninguna consulta se llama «${name}».`,
    tooMany: (max) => `${max} consultas como máximo: elimine una antes.`,
    refused: (detail) => `InfluxDB rechaza esta consulta: ${detail}`,
    notChecked: 'guardada, pero no comprobada',
    noQuery: 'ninguna consulta: use «Añadir una consulta»',
  },
};

// Why "Add a query" refuses its fields (src/queries.js QUERY_ERRORS).
export const QUERY_FIELD_TEXT = {
  name: {
    en: 'Give the query a name (60 characters at most).',
    fr: 'Donnez un nom à la requête (60 caractères au plus).',
    de: 'Gib der Abfrage einen Namen (höchstens 60 Zeichen).',
    es: 'Dé un nombre a la consulta (60 caracteres como máximo).',
  },
  query: {
    en: 'Enter the query (4000 characters at most).',
    fr: 'Saisissez la requête (4000 caractères au plus).',
    de: 'Gib die Abfrage ein (höchstens 4000 Zeichen).',
    es: 'Introduzca la consulta (4000 caracteres como máximo).',
  },
  type: {
    en: 'Choose a type in the list.',
    fr: 'Choisissez un type dans la liste.',
    de: 'Wähle einen Typ aus der Liste.',
    es: 'Elija un tipo de la lista.',
  },
  label: {
    en: 'A tag name has 64 characters at most, e.g. room.',
    fr: "Un nom d'étiquette a 64 caractères au plus, ex. room.",
    de: 'Ein Tag-Name hat höchstens 64 Zeichen, z. B. room.',
    es: 'Un nombre de etiqueta tiene 64 caracteres como máximo, p. ej. room.',
  },
};

// Scene action messages (shown in Gladys).
export const ACTION_TEXT = {
  noServer: {
    en: 'No InfluxDB is configured.',
    fr: "Aucune InfluxDB n'est configurée.",
    de: 'Es ist keine InfluxDB konfiguriert.',
    es: 'No hay ninguna InfluxDB configurada.',
  },
  noQuery: {
    en: 'Enter a query.',
    fr: 'Saisissez une requête.',
    de: 'Gib eine Abfrage ein.',
    es: 'Introduzca una consulta.',
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
/** The parts of a report, in one language: "a, b, c." */
export const sentence = (parts) => `${parts.filter(Boolean).join(', ')}.`;
