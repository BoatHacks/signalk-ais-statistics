# Verified Findings

Facts about the SignalK server, its History API and Freeboard-SK that the
design depends on, each with how to check it again. Findings were collected
on 2026-10-30 against a test server running SignalK server 2.35.1 with
`signalk-questdb` 2.3.2 as the default history provider and Freeboard-SK 3.3.0.
Re-check anything here before relying on it for a different server version.

In the commands, `$SK` is the base URL of a SignalK server, for example
`http://localhost:3000`.

## History API

A provider is registered by a plugin and used through the server's v2 History
API.

```bash
curl -s $SK/signalk/v2/api/history/_providers
curl -s $SK/signalk/v2/api/history/_providers/_default
```

- The provider list and the default provider are readable without
  authentication on a server that allows read-only access.
- `values` queries need `from`, `to` and `resolution` (seconds). Without a
  `resolution` the provider returned no rows.

```bash
curl -s "$SK/signalk/v2/api/history/values?paths=<path>:last&from=<iso>&to=<iso>&resolution=3600"
```

- The aggregate is the suffix after the path. The provider accepts
  `average`, `min`, `max`, `first`, `last`, `mid`, `middle_index`, `sma` and
  `ema`. `sum`, `count` and `median` are rejected with "unknown aggregation
  method". This is why counts are published as cumulative counters (SPEC 4.1).
- A `last` query returns `null` for buckets before the first recorded sample,
  and repeats the previous value for later buckets that have no new sample.
- The response shape is `{ context, range, values: [{ path, method }], data:
  [[timestamp, value], ...] }`.

Only this one provider has been checked. The plugin must not assume more than
the aggregates above.

## Raw AIS sentences

- Plugins receive raw NMEA 0183 sentences with `app.on('nmea0183', handler)`.
- The handler gets the sentence as a plain string. There is no source label
  and no timestamp, so own-transponder sentences (`!AIVDO`) are told apart by
  prefix and reception time is the time of the call.
- The server's AIS decoding dependency is `ggencoder` (version 1.0.13 with the
  tested server), pulled in by `@signalk/nmea0183-signalk`.

## Plugin routes and permissions

- Routes a plugin registers on its router are admin-only unless the plugin
  registers permissions for them.
- On server 2.35.1 the plugin router has `router.access('readonly')`, which
  registers read-only access for the routes defined through it. Older servers
  do not have it, so guard with `router.access ? router.access('readonly') :
  router`.
- Data that should be readable anonymously can instead be served through the
  Resources API with `app.registerResourceProvider`.

## Chart plotter overlay (Freeboard-SK)

- Freeboard-SK reads plugin-provided extensions from the `plotterExtensions`
  resource type. A plugin registers a read-only resource provider for that
  type serving one manifest keyed by the plugin id, and returns nothing while
  the plugin is stopped. The `@meri-imperiumi/signalk-internet` plugin is a
  working example (see its `registerReadOnlyProvider`).
- A data overlay needs `requires: ["overlays.data"]` and an `overlays` entry
  with `type: "data"`, a `band` and a MapLibre `style`. The style can point at
  a GeoJSON file served by the plugin.
- Live updates need a context that calls `overlay.refresh` or
  `overlay.setData`. The documentation describes no server-only way, so a
  background iframe page is needed.
- Documentation: the Plotter Extensions API page in the Freeboard-SK
  repository, `docs/api/plotter-extensions-api.md`.

## SignalK schema

- `sensors.<name>` is defined as one sensor object with the keys `name`,
  `sensorType`, `sensorData`, `fromBow`, `fromCenter` and `class`. Other keys
  are not forbidden, and `sensors.ais.status` is already published by another
  plugin, so `sensors.ais.statistics.*` conflicts with nothing.

## Related plugins on a typical server

- `@meri-imperiumi/signalk-internet` publishes `network.internet.state` with
  the values `online`, `offline` or `metered`; the web app uses it to choose
  the default basemap.
- `signalk-questdb` is a History API provider that records every path,
  including AIS targets, with default sampling every 2 seconds and unchanged
  values re-written every 300 seconds.

## Not yet verified

See SPEC section 13: counter reset across a plugin restart, and the size of a
coverage layer Freeboard-SK handles smoothly.
