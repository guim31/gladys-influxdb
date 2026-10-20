# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the API token and the password (InfluxDB 1) are `secret`
  fields of the Gladys configuration. The integration reads them from Gladys
  at startup, keeps them in memory, sends them only in the `Authorization`
  header of its requests to the InfluxDB address of the configuration, and
  never writes them to `/data` nor to the logs. An address with credentials
  inside (`http://user:pass@…`) is refused, so that none ends up in a log
  line. A read-only token is enough, and recommended.
- **Stored in `/data`**: `influxdb-state.json`, the queries added by the user
  (name, query text, type, tag, names of the series already seen) and the
  scene events already announced (server unreachable since when, failing
  queries). No secret, no measure.
- **Writes**: none. The integration only reads InfluxDB (`/ping`, `/query`,
  `/api/v2/query`, `/api/v3/query_sql`); the queries are the user's own, run
  with the rights of the token.
- **Network**: requests go only to the address typed in the configuration, in
  HTTP or HTTPS (InfluxDB Cloud included). HTTPS certificates are verified
  unless the user ticks "Accept self-signed certificates"; the integration
  opens no port and calls no other service.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
InfluxDB itself, and what writes into it.
