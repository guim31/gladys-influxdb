# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/hub.test.js              # one file
node --test --test-name-pattern "widget"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: src/app.js registers the handlers before connect()
src/app.js                        every SDK handler -> the hub (also used by the tests)
src/hub.js                        reading timer, queries, states (changes + heartbeat), scene events
src/devices.js                    query devices, one feature per series, values
src/queries.js                    query types (category, unit, bounds), "Add a query" fields, ids
src/influxdb/client.js            /ping, Flux, InfluxQL and SQL requests, error kinds
src/influxdb/model.js             Flux CSV, InfluxQL and SQL answers -> series, series names
src/influxdb/http.js              node:http/https (self-signed certificates on request)
src/scenes.js                     scene action handlers (manifest `scene_actions`)
src/widgets.js                    dashboard widget `values` (manifest `widgets`)
src/texts.js                      connection, error, report, action texts (4 languages)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/store.js                      /data/influxdb-state.json (queries, series names, events announced)
src/logs.js                       repeated failures logged once, then once when they heal
gladys-assistant-integration.json manifest: name, config_schema, actions, triggers, widget...
docs/{en,fr,de,es}.md             user documentation, re-hosted by Gladys (en and fr mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
                                  and helpers/fakeInflux.js (real answers in test/fixtures/real)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** exists in English, French, German and Spanish: action
  messages, widget texts, manifest texts, and `docs/{en,fr,de,es}.md`, kept in
  sync (`test/i18n.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

---

# Notes du mainteneur (guim31)

Ce qui suit complète les règles du template ci-dessus. Ce sont des faits vérifiés dans le code du
cœur Gladys ou payés sur les intégrations déjà publiées par guim31. Ils ne se lisent pas dans le
code de ce dépôt. Compléter ce fichier quand un nouveau piège est découvert.

## Travailler sur ce dépôt

- Mêmes étapes que la CI, dans le même ordre : `npm ci`, `npm run format:check`, `npm run lint`,
  `npm test`. Prettier contrôle **aussi le Markdown** : lancer `npm run format` après avoir
  modifié ce fichier, le README ou la documentation, sinon la CI tombe.
- Une session de code n'a **ni instance Gladys ni appareil réel**. La suite de tests, le lint et
  le validateur du store sont les seules vérifications possibles : le test réel se fait ailleurs.
  Le dire, plutôt que de conclure que « ça marche ».
- **Tout le code de démonstration du template disparaît** : station météo, prise, lampe, caméra,
  capteur de mouvement, `src/weather.js`, leurs tests, leurs entrées du manifeste et de la
  documentation. Il ne reste que ce que l'intégration fait vraiment.
- **Publier n'est jamais le travail d'une session de code** : ni Release, ni tag, ni topic, ni
  version modifiée à la main. L'orchestrateur s'en charge une fois la PR fusionnée. Les workflows
  sont ceux du template : ne pas les modifier.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.

## Pièges du cœur Gladys

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe, **en millisecondes** (1000, 2000, 10000,
  15000, 30000, 60000). Le template publie `poll_frequency: 300` sans `should_poll` : c'est faux,
  le cœur répond 400 à la découverte. Pour une cadence hors liste, publier `should_poll: false` et
  pousser les états depuis le conteneur, en gardant un `onPoll` de repli.
  **Piège du 5.2.0** (GladysAssistant/Gladys#3198, correctif #3199, relevé sur gladys-ping-wol) :
  un appareil **créé sans `should_poll`** n'est jamais sondé, même après correction du cœur (valeur
  stockée à la création), et la 5.2.1 du 13/10/2026 ne le corrige pas. **Le conteneur sonde donc
  lui-même** par un minuteur, qui saute un appareil sondé il y a moins d'une demi-période, en gardant
  `onPoll` comme repli ; seuls les appareils ajoutés (`gladys.devices`) sont lus. Un test le prouve
  sans appeler `onPoll`.
- **`min` et `max` sont NOT NULL** dans `t_device_feature`, y compris pour `text/text` : sans eux,
  « Ajouter à Gladys » échoue en HTTP 422. Mettre 0/0, comme Zigbee2MQTT.
- Un état publié sur une fonctionnalité **pas encore ajoutée** dans Gladys reçoit un 200 puis est
  jeté (simple ligne de log) : republier les états dans `onDeviceCreated`.
- `level-sensor/decimal` n'existe pas côté serveur. `light-sensor/binary` n'a pas de libellé dans
  le front (pastille vide) : préférer `input/binary`. Un `text/text` reçoit `{ text }`, jamais
  vide, sinon l'état est ignoré.
- **Détecteur d'ouverture (`opening-sensor`) : 0 = ouvert, 1 = fermé** (`OPENING_SENSOR_STATE`), à
  l'inverse de l'intuition et des autres détecteurs (mouvement, fuite, fumée : 1 = détecté). Une
  porte ouverte publiée à 1 s'affiche « Fermé » et fausse scènes et historique. Le figer par un test.
- **Un `external_id` de fonctionnalité ne change jamais d'appareil** d'une version à l'autre. UniFi
  1.5.2 avait sorti les ports PoE dans un appareil dédié, la 1.6.0 les a remis dans la passerelle avec
  les mêmes identifiants : ceux qui avaient ajouté l'appareil dédié ne peuvent plus « Mettre à jour » la
  passerelle (409 `external_id must be unique`). Pour regrouper, garder l'appareil existant
  (`gladys.getDevices()`) ou changer d'identifiant.
- Les **noms de fonctionnalités sont figés à la création**. Et quand une fonctionnalité est seule
  de son type sur l'appareil, le tableau de bord affiche le libellé générique du type à la place
  du nom publié.
- **Aucune commande d'appareil ne permet un choix multiple** : un `text/select` n'a qu'un choix
  actif.
- Un changement de structure fait proposer « Mettre à jour » dans l'onglet Découverte
  (`structure_changed`). Un changement des seules `supported_options` ne le déclenche pas.
- **Jauge** : l'aiguille se place par `(value - min) / (max - min)` des bornes de la
  fonctionnalité. `gauge_min`/`gauge_max` ne pilotent que les couleurs, et le cœur n'applique
  jamais `min`/`max` en écriture : ce sont des bornes d'affichage. Une valeur signée exige des
  bornes symétriques.
- Le cœur plafonne à **300 états par minute** et réévalue les scènes à chaque état : ne publier
  que les changements.
- Une intégration `device` ne reçoit pas la langue de l'utilisateur, une action de scène non
  plus (un widget, si) : prévoir un champ de config `language` si des textes partent du
  conteneur. Le superviseur injecte `TZ`, le fuseau de Gladys. La sandbox est limitée à 256 Mo.

**Formulaires de configuration et actions**

- Les champs `number` sont rendus **sans `step`** : le navigateur n'accepte alors que `min + k`.
  Min et défaut **entiers** seulement ; une valeur décimale passe par un `select` ou par un
  `string` parsé (virgule acceptée).
- Un champ `secret` dans les `fields` d'une **action** est impossible à remplir, et une action
  n'applique **aucun `default`** tout en exigeant les champs `required` (422). Issues
  GladysAssistant/Gladys#3154 et #3155.

**SDK 0.15 et journaux**

- SDK `@gladysassistant/integration-sdk` **^0.15.0** (12/10/2026) : `DEVICE_POLL_FREQUENCIES`, faux
  Gladys de test (`@gladysassistant/integration-sdk/testing`, à préférer à un faux maison),
  déduplication des états, `parseMdnsTxt`. Lire son README et son CHANGELOG.
- **Journaux calmes** (demande de Guilhem, 13/10/2026) : rien au niveau info pour un cycle normal de
  lecture, un état publié ou un message reçu. L'info ne garde que le cycle de vie : démarrage,
  connexion, perte et retour d'un appareil ou d'un service, erreurs utiles, une ligne par action de
  l'utilisateur. Le reste passe en debug (`LOG_LEVEL=debug`). Une erreur qui se répète écrit une ligne
  au premier échec et une au rétablissement, pas une par tentative. Jamais de secret ni d'adresse
  avec identifiants. Un test vérifie qu'un cycle normal n'écrit rien en info.
- **Heartbeat** : republier au moins toutes les 12 h une valeur qui ne change pas, sinon le front
  affiche « Pas de valeur récente » au-delà de 48 h.

**Widgets, déclencheurs, actions de scène (SDK ≥ 0.14, Gladys ≥ 5.1)**

- **Cibler la dernière version publiée du cœur, pas `master`** : la spec de `master` décrit des
  fonctions non publiées. Les boutons de widget qui ouvrent un formulaire (#3168, commit 3feb2cf8)
  sont absents de la 5.1.4 mais **livrés dans la 5.2.0** (sortie le 12/10/2026) : `gladys_version`
  `>=5.2.0` si on s'en sert, ou un bouton direct en repli. Vérifier par `git tag --contains`.

- Un réglage de widget ne propose en liste que les **appareils** de l'intégration
  (`source: "devices"`, seule source dynamique).
- Budget du cœur : **8 composants par widget, dont 2 textes au plus**, appliqué **avant** la
  résolution des références ; un contenu amputé reste en cache jusqu'au TTL. Appeler
  `requestWidgetRefresh` à la création d'un appareil. `validateWidgetContent` est exporté pour les
  tests, mais ne vérifie pas que les `external_id` liés existent : les croiser avec `buildDevice`.
- Une ligne de `status` exige un `value` (nombre ou texte ≤ 40).
- Le cœur **jette un bouton dont la clé d'action est déjà prise** : clés numérotées.
- Le vocabulaire des widgets n'a ni liste ni curseur, **par choix** du cœur. Seul un bouton
  `device_feature` numérique a un état actif natif.
- **En mode sombre, le style `primary` d'un bouton de widget ne se voit pas** (#3153) : signaler
  un choix courant par l'icône (`check-circle`), jamais par le style.
- Dans une grille `card-list`, la `date` s'affiche **à la place** du sous-titre.
- `onWidgetAction` fait recharger le widget dès la résolution, alors que `requestWidgetRefresh`
  est plafonné à un appel toutes les 10 s. Un toast d'action est tronqué à 200 caractères.
- Le cœur met le contenu d'un widget en cache par (réglages, langue, unités) : pré-localiser
  d'après `language` est correct.
- Les filtres de scène ne font qu'égalité et appartenance : un seuil reste le travail d'un capteur.
- **Les clés de widgets, de déclencheurs et d'actions sont figées une fois publiées.**
- `gladys_version` `>=5.1.0` dès qu'il y a widgets, déclencheurs ou actions de scène.

## Store

- Validateur officiel, depuis la racine : `npx -y github:GladysAssistant/integration-store .`
  (schéma, `description` **100 caractères au plus par langue**, documentation de 300 caractères
  au moins, image Docker, cover de **150 Ko au plus**). Il demande Node ≥ 24 mais tourne sous
  Node 22 avec un avertissement.
- L'indexeur lit le manifeste de la **dernière release**, pas celui de `main` : une correction du
  manifeste (catégorie, description…) n'atteint le store qu'avec une release.
- L'indexeur rejette **en silence** : la raison n'apparaît que dans `rejected.json`, à côté de
  `https://integration-store-storage.gladysassistant.com/index.json`.
- **Image de base** : `FROM public.ecr.aws/docker/library/node:…` (miroir officiel ECR Public, même
  empreinte) et non `node:…` de Docker Hub, qui refuse en 429 les pulls anonymes des runners GitHub
  dès qu'il y a plusieurs builds à la fois. Un échec 429 dans le job « Docker build » n'est pas un bug
  du code. Même parade dans `.github/workflows/build.yml` (posée par l'orchestrateur, ne pas la
  retirer) : QEMU et BuildKit tirés de `mirror.gcr.io`.
- La règle `data/` du `.gitignore` du template (pour le volume `/data`) exclut aussi `src/data/` :
  l'ancrer en `/data/`, dans `.prettierignore` aussi.

### Langues (depuis le 11/10/2026)

Tout texte montré à l'utilisateur existe en **`en`, `fr`, `de` et `es`** : manifeste, contenu des widgets, messages,
noms de fonctionnalités. L'allemand **tutoie** (« du »), l'espagnol **vouvoie** (« usted ») : décision de Guilhem,
appliquée à ses 21 intégrations. `test/i18n.test.js` doit échouer sur une langue manquante, un texte vide ou trop
long, et sur un « Sie »/« Ihr… » de politesse en allemand. Le store exige `docs/en.md` et `docs/fr.md`
(`DOCS_LANGUAGES`) et publie aussi `docs/de.md` et `docs/es.md` quand ils existent
(`DOCS_OPTIONAL_LANGUAGES` d'integration-store) : écrire les quatre, avec les mêmes sections.

## Choix par défaut de Guilhem (12/10/2026)

- Langue par défaut des noms de fonctionnalités et des textes produits par le conteneur : **`fr`**.
- Fichier `LICENSE` Apache-2.0 (texte complet) à la racine.
- `transports` : `local` seul quand le cloud n'est qu'une option annexe.
- Docs `en`, `fr`, `de`, `es` avec les mêmes sections.
- Chauffe, ouverture, sécurité : ne rien rendre pilotable « comme un thermostat » ou par un assistant
  vocal quand une erreur serait dangereuse (leçon d'OctoPrint).

## InfluxDB (propre à ce dépôt)

- **Trois API au choix** (`api_version`), une seule par configuration : `v2` = Flux (`POST
/api/v2/query?org=` ou `orgID=` si 16 hex, `Authorization: Token`, CSV annoté demandé par
  `dialect.annotations`), `v1` = InfluxQL (`GET /query?db=&q=&epoch=ms`, Basic ou `Token` : marche
  aussi sur l'API de compatibilité d'InfluxDB 2 et sur InfluxDB 3 Core), `v3` = SQL (`GET
/api/v3/query_sql?db=&format=json`, `Bearer`). Basic avec un jeton est refusé par InfluxDB 3 (400) :
  ne pas l'envoyer.
- **Santé** : `/ping` donne la version (`X-Influxdb-Version`) sans authentification sur 1.x et 2.x
  (204), **avec** jeton sur 3 Core (200 JSON, 401 sinon). Comme `/ping` ne vérifie rien sur 1.x et
  2.x, **chaque lecture** lance d'abord une requête qui ne lit rien (`client.check()` : `array.from`
  en Flux, `SHOW RETENTION POLICIES`, `SELECT 1`) pour que « Tester la connexion » voie un jeton
  ou une organisation faux. Testé avec un jeton en lecture seule sur 2.9.
- **Réponses réelles** (`test/fixtures/real`, InfluxDB 1.11.8, 2.9.1, 3 Core 3.12.1) : Flux en
  erreur = 400 `{code:"invalid"}` (compilation, exécution) ou 404 `{code:"not found"}` (bucket) →
  erreur de requête ; organisation inconnue = **400** `invalid` « organization name … not found » →
  erreur serveur `organization`. InfluxQL : syntaxe = 400 `{error}` sur 1.x, mais **200 avec
  `results[].error`** sur 3 Core ; base inconnue = 200 + `results[].error` « database not found »
  (→ `database`, erreur serveur). SQL : erreur = **400 en texte brut** ; base inconnue = 404 JSON.
  InfluxDB 2 répond **200 HTML** (son interface) à tout chemin inconnu : `not_influx`.
- **Séries** : Flux = une par table, étiquettes = clé de groupe **sans `_start`/`_stop`** (elles
  changent à chaque lecture), dernière ligne ; sans `_value` (après `pivot()`), chaque colonne
  numérique hors clé de groupe est une série `_field` = même identité que sans pivot. InfluxQL = une
  par série (`_measurement` + tags), dernière ligne ; plusieurs colonnes → `_field` = nom de colonne
  (`last`, `last_1` sans `AS`) ; plusieurs instructions → `_statement`. SQL = colonnes texte =
  étiquettes, colonnes nombre/booléen = valeurs, la première ligne d'une série l'emporte.
  Booléen = 1/0, texte ignoré ; des lignes sans aucun nombre = `not_number`, refusé à l'ajout.
  Relecture du 20/10 : en Flux, le nom du `yield()` est dans `#default` (cellule `result` vide), et
  après `window()` sans agrégat la **dernière** table d'une même clé l'emporte ; en InfluxQL,
  `_statement` dès qu'il y a plusieurs résultats, vides compris (identité stable) ; en SQL, une
  colonne texte au format date n'est pas une étiquette.
  Identité, noms figés, plafonds 20 × 20, `<type>_<série>` : comme gladys-prometheus.
- **Déclencheurs** : `server_unreachable` après **2 lectures de suite** en erreur serveur (une mise à
  jour d'InfluxDB ne lance pas les scènes), `server_back` seulement s'il a été annoncé (durée en
  minutes), `query_failed` une fois par épisode (une requête vide n'est pas un échec), ré-armé
  quand la requête remarche. L'état annoncé vit dans `/data` (`events`) : pas de doublon ni d'oubli
  au redémarrage. Seul `check()` décide d'une erreur serveur `auth`/`database` : la même erreur
  venue d'une requête (base lue par son nom complet, jeton sans droit sur un bucket) ne concerne
  qu'elle (`QUERY_SERVER_ERRORS`). Panne datée du premier échec ; changer de serveur oublie la panne
  annoncée de l'ancien. Requêtes lancées 5 par 5 (20 requêtes lentes tiennent dans le délai de
  « Tester la connexion »).
- **Badge** : `cloud` si l'hôte finit par `influxdata.com`/`.io` (InfluxDB Cloud), `local` sinon,
  `unreachable` en panne. Manifeste `transports: ["local", "cloud"]` (consigne du brief, Cloud non
  testé faute de compte).
- **Widget `values`** : une ligne par série (dernière valeur + unité, séparateur décimal de la
  langue), réglage `queries` (`multi_select`, `source: "devices"`) qui reçoit des `external_id`
  d'appareils.

## Vérifié sur de vrais InfluxDB (20/10/2026)

Image Docker de l'intégration avec les contraintes du bac à sable (`--cap-drop ALL --security-opt
no-new-privileges --read-only --memory 256m --pids-limit 256`, volume `/data`, réseau en pont
`gladys-test-influxdb`, aucun port publié) contre les images officielles `influxdb:1.11` (1.11.8,
authentification active), `influxdb:2` (2.9.1) et `influxdb:3-core` (3.12.1), remplies de données
de test.

- Sans Gladys : reconnexion du SDK en backoff, pas de plantage, aucun secret dans les logs,
  ~19 Mo au repos.
- Faux Gladys du SDK dans le conteneur verrouillé : Flux avec un jeton en lecture seule, Flux avec
  l'organisation tirée de l'adresse de l'interface (`orgID`), InfluxQL en Basic sur 1.11, InfluxQL
  par jeton sur la compatibilité de 2.9 et sur 3 Core, SQL sur 3 Core : appareils, états, widget,
  « Lire une valeur InfluxDB » ; jeton, mot de passe, organisation et base faux, SQL demandé à un
  InfluxDB 2, hôte inconnu, `https://` sur un port HTTP ; requête refusée et requête texte à
  l'ajout ; InfluxDB 1 arrêté puis relancé : `server_unreachable` puis `server_back` ;
  redémarrage sans doublon.
