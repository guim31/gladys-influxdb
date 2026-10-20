# InfluxDB

Faites entrer dans Gladys les mesures que votre
[InfluxDB](https://www.influxdata.com/) contient déjà — collectées par
Telegraf, un script, une autre domotique : les requêtes que vous choisissez
deviennent des capteurs (la température de chaque pièce, la puissance d'un
onduleur solaire, l'énergie du jour), et vos scènes réagissent quand InfluxDB
ne répond plus ou qu'une requête échoue. Un widget de tableau de bord montre
les dernières valeurs d'un coup d'œil.

L'intégration lit InfluxDB sur votre réseau local, ou InfluxDB Cloud. Elle ne
fait que lire : rien n'est écrit dans InfluxDB.

Testée contre de vrais serveurs InfluxDB 1.11, 2.9 et 3 Core 3.12 (images
Docker officielles, données à plusieurs séries et étiquettes, requêtes Flux,
InfluxQL et SQL, jeton en lecture seule). InfluxDB Cloud utilise la même API,
non testée. Vos retours sont les bienvenus :
[github.com/guim31/gladys-influxdb/issues](https://github.com/guim31/gladys-influxdb/issues).

## Ce qu'il faut

- Gladys Assistant 5.1.0 ou plus récent.
- InfluxDB 1.x, 2.x, 3 Core ou Enterprise, joignable depuis la machine de
  Gladys (port 8086, 8181 pour InfluxDB 3), ou un compte InfluxDB Cloud.
- Un accès :
  - InfluxDB 2 et Cloud : un **jeton d'API** qui peut lire vos buckets, et le
    nom de l'**organisation** ;
  - InfluxDB 1 : un utilisateur et un mot de passe (si l'authentification est
    active) ;
  - InfluxDB 3 : un jeton (sauf s'il tourne sans authentification).

## Pour commencer

### 1. Configurer l'intégration

Dans Gladys, ouvrez la configuration de l'intégration :

- **API et langage de requête** :
  - **InfluxDB 2 ou Cloud (Flux)** : requêtes en Flux ;
  - **InfluxQL (InfluxDB 1, 2 ou 3)** : requêtes en InfluxQL. Fonctionne aussi
    avec InfluxDB 2 (son API de compatibilité v1, le bucket comme base) et
    InfluxDB 3 ;
  - **InfluxDB 3 (SQL)** : requêtes en SQL.
- **Adresse d'InfluxDB** : ex. `http://192.168.1.2:8086`. Un simple
  `192.168.1.2` prend le port 8086 (8181 pour InfluxDB 3). L'adresse d'une
  page de l'interface d'InfluxDB 2 convient aussi, et donne l'organisation.
- **Organisation (InfluxDB 2, Cloud)** : son nom ou son identifiant.
- **Base de données (InfluxQL, SQL)** : ex. `telegraf` ; avec InfluxDB 2, le
  nom du bucket.
- **Jeton d'API** : InfluxDB 2, Cloud et 3. Un jeton en lecture seule suffit.
- **Utilisateur (InfluxDB 1)**, **Mot de passe (InfluxDB 1)** : InfluxDB 1 avec
  authentification. Le jeton l'emporte si les deux sont remplis.
- **Intervalle de rafraîchissement** : 1 minute par défaut, de 30 secondes à
  10 minutes.
- **Accepter les certificats auto-signés** : seulement pour une adresse en
  `https://` dont le certificat n'est pas reconnu par votre navigateur non
  plus.
- **Langue des messages** : la langue des résultats de scène et des messages.
  Les noms des fonctionnalités viennent de vos étiquettes.

Cliquez sur **Tester la connexion** : elle répond par la version d'InfluxDB et
les requêtes, ou par ce qui ne va pas.

### 2. Ajouter vos requêtes

Toujours dans la configuration, l'action **Ajouter une requête** demande :

- **Nom** : le nom de l'appareil, ex. `Températures des pièces`. Ajouter une
  requête du même nom la remplace (même appareil).
- **Requête (Flux, InfluxQL ou SQL)** : dans le langage de l'API choisie. Elle
  doit donner une valeur par série : la dernière, une moyenne… Par exemple :
  - InfluxQL : `SELECT last(value) FROM temperature WHERE time > now() - 1h GROUP BY room` ;
  - Flux : `from(bucket: "home") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "temperature") |> last()` ;
  - SQL : `SELECT room, last_value(value ORDER BY time) AS value FROM temperature WHERE time > now() - INTERVAL '1 hour' GROUP BY room`.
- **Type** : ce que Gladys affiche. Nombre (sans unité), Température (°C),
  Humidité (%), Pourcentage (%), Puissance (W), Énergie (kWh). Convertissez
  dans la requête si besoin (`/ 1000` pour des kWh à partir de Wh).
- **Étiquette qui nomme les séries (facultatif)** : quand la requête renvoie
  plusieurs séries, chacune devient une fonctionnalité nommée d'après cette
  étiquette (ex. `room`). Vide : les étiquettes qui changent d'une série à
  l'autre.

La requête est d'abord vérifiée auprès d'InfluxDB : une erreur est répondue
avec le message d'InfluxDB, et rien n'est enregistré. **Supprimer une
requête** demande un nom.

Ce qui fait une série :

- **Flux** : une par table (la clé de groupe : étiquettes, `_measurement`,
  `_field`), sa dernière ligne. Après un `pivot()`, chaque colonne numérique
  est sa propre série.
- **InfluxQL** : une par série de la réponse (étiquettes du `GROUP BY`), sa
  dernière ligne. `SELECT last(a), last(b)` donne une série par colonne.
- **SQL** : les colonnes de texte nomment les séries, chaque colonne
  numérique est une valeur ; la première ligne d'une série l'emporte
  (`ORDER BY time DESC`).

Les booléens comptent pour 1 et 0 ; les valeurs texte sont ignorées. En SQL, ne
sélectionnez que les colonnes de texte qui nomment une série : un statut qui
change ferait une nouvelle série (les dates écrites en texte sont ignorées).

### 3. Ajouter les appareils

Ouvrez l'onglet **Découverte** de l'intégration et ajoutez les appareils à
suivre.

## Les appareils

**Un appareil par requête**, avec une fonctionnalité par série, 20 au plus,
du type choisi. Le nom d'une fonctionnalité est fixé à la première apparition
de la série, et Gladys le garde une fois l'appareil ajouté. Une série vue plus
tard ajoute une fonctionnalité : Gladys propose alors **Mettre à jour** dans
l'onglet Découverte. Une série qui disparaît garde sa fonctionnalité, sans
nouvelles valeurs.

Un appareil est marqué injoignable tant qu'InfluxDB ne répond pas, et garde
ses dernières valeurs. Son badge indique cloud pour InfluxDB Cloud.

## Tableau de bord

Le widget **Valeurs InfluxDB** montre la dernière valeur de chaque requête,
une ligne par série avec son unité, ou « Erreur » pour une requête refusée par
InfluxDB. Dans ses réglages, choisissez les requêtes à montrer (leurs
appareils) ; vide : toutes. Le bouton **Actualiser** relit InfluxDB.

## Scènes

### Déclencheurs

- **InfluxDB est injoignable** : deux lectures de suite échouent (pas de
  réponse, accès refusé, organisation ou base introuvable). Donne l'erreur, et
  sa clé (`unreachable`, `auth`, `organization`, `database`…).
- **InfluxDB répond de nouveau** : après le premier déclencheur, une lecture
  fonctionne de nouveau. Donne la durée de la panne en minutes.
- **Une requête échoue** : InfluxDB refuse une requête (syntaxe, bucket ou
  table inconnus, pas de droit dessus), ou sa réponse n'a aucun nombre. Une fois, jusqu'à ce que la requête remarche. Filtre : le
  nom de la requête (vide : n'importe laquelle). Donne le nom de la requête et
  l'erreur.

Ce qui a été annoncé est gardé : un redémarrage ne l'annonce pas deux fois, et
n'oublie pas de dire qu'InfluxDB est revenu. Une requête sans donnée pour le
moment n'est pas un échec.

### Actions

- **Lire une valeur InfluxDB** : exécute une requête une fois, sans créer
  d'appareil. Résultats : la valeur de la première série (0 s'il n'y en a
  aucune), le nombre de séries, et les valeurs en texte
  (`kitchen : 21.5, attic : 15.75`).

### Idées de scènes

- **InfluxDB est injoignable** → envoyer « InfluxDB : {erreur} » sur votre
  téléphone ; et **InfluxDB répond de nouveau** → « InfluxDB est revenu après
  {durée} minutes ».
- Une température de l'appareil « Températures des pièces » au-dessus de
  26 °C → fermer les volets de cette pièce.
- Chaque soir → **Lire une valeur InfluxDB** avec l'énergie du jour
  (`SELECT sum(kwh) FROM solar WHERE time > now() - 1d`) et envoyer « Solaire
  aujourd'hui : {valeur} kWh ».

## Dépannage

- **« ne répond pas »** : vérifiez l'adresse et le port depuis la machine de
  Gladys (`curl -i http://192.168.1.2:8086/ping`). Gladys fait tourner
  l'intégration dans un conteneur sur un réseau en pont : `localhost` est le
  conteneur, pas l'hôte.
- **« accès refusé »** : le jeton, ou l'utilisateur et le mot de passe, sont
  refusés ; ou le jeton ne peut pas lire ce bucket ou cette base.
- **« organisation introuvable »**, **« base de données introuvable »** :
  vérifiez le nom dans la configuration (InfluxDB 2 : l'organisation du
  jeton).
- **« certificat refusé »** : cochez **Accepter les certificats auto-signés**.
- **« l'adresse redirige »** : saisissez l'adresse en `https://`.
- **« pas d'API InfluxDB de la version choisie à cette adresse »** : un autre
  service répond là, ou l'API choisie n'est pas celle du serveur (SQL demande
  InfluxDB 3).
- **« le résultat n'a aucun nombre »** : la requête ne renvoie que du texte ;
  choisissez un champ numérique.
- **Une requête ne montre aucune valeur** : **Tester la connexion** indique
  quelle requête n'a pas de donnée pour le moment. Essayez-la dans
  l'interface d'InfluxDB (Data Explorer), ou avec la commande `influx`.
- **Logs** : dans Gladys, la page de l'intégration montre ses logs. Ajoutez
  `LOG_LEVEL=debug` pour voir chaque lecture.

## Limites

- 20 requêtes, et 20 séries par requête. Une requête s'exécute à chaque
  rafraîchissement : bornez-la dans le temps (`WHERE time > now() - 1h`,
  `range(start: -1h)`) pour qu'InfluxDB ne parcoure pas tout votre historique
  chaque minute.
- Lecture seule : les états de Gladys ne peuvent pas être écrits dans InfluxDB
  depuis une intégration externe.
- Les requêtes sont gardées dans le volume de données de l'intégration : la
  réinstaller de zéro les perd (ajoutez-les de nouveau avec les mêmes noms :
  mêmes appareils).
- Les valeurs sont arrondies à deux décimales.
- Une base (InfluxQL, SQL) par configuration ; en InfluxQL, une autre se lit
  par son nom complet (`"db"."autogen"."measurement"`).
- InfluxDB Cloud : même API, non testée faute de compte ; attention aux quotas
  de lecture de votre offre (une requête HTTP par requête et par
  rafraîchissement).
- Testée avec les outils de test du SDK Gladys et de vrais serveurs InfluxDB,
  pas encore dans une vraie instance Gladys : vos retours sont les bienvenus.
