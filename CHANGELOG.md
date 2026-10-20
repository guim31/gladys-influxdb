# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- InfluxDB in Gladys: one device per query, added with the "Add a query"
  configuration action (name, query, type, tag naming the series), one feature
  per series (20 at most); types number, temperature, humidity, percentage,
  power and energy.
- Three query languages: Flux (InfluxDB 2 and Cloud), InfluxQL (InfluxDB 1,
  and the compatibility API of InfluxDB 2 and 3) and SQL (InfluxDB 3); a
  token, or a user and password for InfluxDB 1.
- Scene triggers "InfluxDB is unreachable", "InfluxDB answers again" and "A
  query fails", never repeated nor forgotten across a restart.
- Scene action "Read an InfluxDB value": a query run once, without a device.
- Dashboard widget "InfluxDB values": the last value of every query, or of
  the chosen ones.
- "Test the connection", self-signed certificates on request, texts and
  documentation in English, French, German and Spanish.
