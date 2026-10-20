# InfluxDB for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for
[InfluxDB](https://www.influxdata.com/): the queries you choose — in Flux,
InfluxQL or SQL — become Gladys sensors, so that the measures already collected
elsewhere (Telegraf, scripts, another home automation system) reach your
dashboards and scenes. Scenes also react when InfluxDB stops answering or a
query fails, and a dashboard widget shows the last values.

It reads InfluxDB on your local network, or InfluxDB Cloud. It never writes
into InfluxDB.

## Features

- **One device per query**, added with the **Add a query** action of the
  configuration: one feature per series (20 at most), named after their tags,
  of the type you choose — number, temperature, humidity, percentage, power or
  energy.
- **Three query languages**: Flux (InfluxDB 2, InfluxDB Cloud), InfluxQL
  (InfluxDB 1, and the compatibility API of InfluxDB 2 and 3), SQL
  (InfluxDB 3 Core and Enterprise).
- **Scene triggers**: InfluxDB is unreachable (two failed reads in a row),
  InfluxDB answers again (with the outage length), a query fails (filter: its
  name).
- **Scene action**: read an InfluxDB value, a query run once without a device.
- **Widget**: the last value of every query, or of the chosen ones, one row
  per series with its unit.
- A token, or a user and password for InfluxDB 1; self-signed certificates on
  request.
- Messages and documentation in English, French, German and Spanish.

## Requirements

- Gladys Assistant 5.1.0 or later.
- InfluxDB 1.x, 2.x or 3 reachable from Gladys, or an InfluxDB Cloud account,
  with read access (a read-only token is enough).

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-influxdb`
   (or install **InfluxDB** from the catalog once it is listed).
2. In **Configuration**, choose the API, enter the address of InfluxDB
   (`http://192.168.1.2:8086`), the organization (InfluxDB 2) or the database
   (InfluxQL, SQL), and the token. Save, then click **Test the connection**.
3. Still in **Configuration**, add your queries with **Add a query** (name,
   query, type).
4. Open the **Discover** tab and add the devices to follow.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

Every minute by default (30 seconds to 10 minutes), the integration calls
`/ping` (health check and version), then runs every query: `POST
/api/v2/query` (Flux, annotated CSV), `GET /query` (InfluxQL) or `GET
/api/v3/query_sql` (SQL). Each table, series or row group of the answer is a
series, identified by its tags (never by `_start`/`_stop`, which move at every
read). The states of the added devices are sent only when they change (and
every 6 hours); the scene events are sent whether a device is added or not. The
queries, the series already named and the events already announced are kept in
`/data`.

## Checked on real InfluxDB servers

On 20/10/2026, against the official Docker images of InfluxDB 1.11.8, 2.9.1
and 3 Core 3.12.1 filled with test data (several measurements, tags and
fields): Flux, InfluxQL (on the three versions) and SQL queries, their real
error answers (syntax, unknown bucket, organization or database, refused
token), and a read-only token on InfluxDB 2. The answers are kept as fixtures
in [`test/fixtures/real`](test/fixtures/real). InfluxDB Cloud uses the same
API but was not tested, for lack of an account. Not yet run in a real Gladys
instance: feedback welcome.

## Limitations

- One InfluxDB per integration; one database for InfluxQL and SQL.
- 20 queries, 20 series per query; values rounded to two decimals.
- Read only: the states of Gladys cannot be exported to InfluxDB from an
  external integration.
- The queries live in the data volume of the integration: a reinstallation
  from scratch loses them.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests run against the fake Gladys of the SDK and an in-memory InfluxDB
(`test/helpers/fakeInflux.js`) seeded with real answers. See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- Started from the official
  [integration template](https://github.com/GladysAssistant/integration-template-js)
  and the [integration SDK](https://github.com/GladysAssistant/integration-sdk-js)
  of Gladys Assistant (Apache-2.0).
- The [InfluxDB integration](https://www.home-assistant.io/integrations/influxdb/)
  of Home Assistant (Apache-2.0) was read for the use case (sensors from
  queries); no code is copied from it.
- The [InfluxDB logo](https://commons.wikimedia.org/wiki/File:Influxdb_logo.svg)
  (InfluxData, public domain on Wikimedia Commons) is used on the cover image.
- Architecture shared with
  [gladys-prometheus](https://github.com/guim31/gladys-prometheus).

## Disclaimer

Not affiliated with InfluxData. InfluxDB is a trademark of InfluxData, Inc.

## License

[Apache-2.0](LICENSE)
