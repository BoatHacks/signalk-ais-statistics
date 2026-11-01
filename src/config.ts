// Plugin options (SPEC section 9). The schema is what the SignalK admin UI
// renders; `resolveConfig` fills defaults and clamps values that would make
// the statistics meaningless.

export interface Config {
  targetExpirySeconds: number
  h3Resolution: number
  coverageDistancePercentile: number
  ownPositionMaxAgeSeconds: number
  coverageRetentionDays: number
  publishIntervalMinutes: number
  publishOverlay: boolean
  sentenceEvents: string[]
}

export const DEFAULT_CONFIG: Config = {
  targetExpirySeconds: 3600,
  h3Resolution: 6,
  coverageDistancePercentile: 99,
  ownPositionMaxAgeSeconds: 60,
  coverageRetentionDays: 14,
  publishIntervalMinutes: 5,
  publishOverlay: true,
  sentenceEvents: ['nmea0183', 'N2KAnalyzerOut'],
}

/** Divisors of an hour, so every interval ends on the hour too. */
export const PUBLISH_INTERVALS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]

/** The allowed interval nearest to the value, or the default. */
function interval(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return PUBLISH_INTERVALS.reduce((best, i) =>
    Math.abs(i - value) < Math.abs(best - value) ? i : best,
  )
}

export const configSchema = {
  type: 'object',
  properties: {
    targetExpirySeconds: {
      type: 'number',
      title: 'Target expiry (seconds)',
      description:
        'A target is dropped from live tracking after this long without a message.',
      default: DEFAULT_CONFIG.targetExpirySeconds,
      minimum: 60,
    },
    h3Resolution: {
      type: 'number',
      title: 'Coverage cell resolution (H3)',
      description:
        'H3 resolution of coverage cells. 5 is about 20 km across (10 km edges), 6 about 7 km (3.7 km edges), 7 about 3 km (1.4 km edges). Finer cells make larger files and overlays.',
      default: DEFAULT_CONFIG.h3Resolution,
      minimum: 3,
      maximum: 8,
    },
    coverageDistancePercentile: {
      type: 'number',
      title: 'Coverage distance percentile cap',
      description:
        'Coverage skips cells with fewer than 3 reports that lie farther than this percentile of the distances in the window, so bogus positions do not inflate the footprint. 100 disables the cap.',
      default: DEFAULT_CONFIG.coverageDistancePercentile,
      minimum: 50,
      maximum: 100,
    },
    ownPositionMaxAgeSeconds: {
      type: 'number',
      title: 'Own position maximum age (seconds)',
      description:
        'Older own positions are treated as unknown; reports received then count toward rates but not toward distance, sectors or coverage.',
      default: DEFAULT_CONFIG.ownPositionMaxAgeSeconds,
      minimum: 1,
    },
    coverageRetentionDays: {
      type: 'number',
      title: 'Coverage retention (days)',
      description:
        'How long the daily coverage cell files are kept. The map and the plotter overlay show up to 7 days.',
      default: DEFAULT_CONFIG.coverageRetentionDays,
      minimum: 1,
    },
    publishIntervalMinutes: {
      type: 'number',
      title: 'Publish interval (minutes)',
      description:
        'How often the statistics paths are published to the server and its history provider. Counters stay exact at any interval; charts read from history are no finer than this. The radar sector distances are published once an hour regardless.',
      default: DEFAULT_CONFIG.publishIntervalMinutes,
      enum: PUBLISH_INTERVALS,
    },
    publishOverlay: {
      type: 'boolean',
      title: 'Offer the coverage overlay to chart plotters',
      description:
        'Registers a Plotter Extensions overlay, for example for Freeboard-SK.',
      default: DEFAULT_CONFIG.publishOverlay,
    },
    sentenceEvents: {
      type: 'array',
      title: 'Server events to read AIS from',
      description:
        'nmea0183 is NMEA 0183 input and N2KAnalyzerOut is NMEA 2000 input, as the server decodes it. Events carrying raw NMEA 0183 sentences also work, such as nmea0183AISout from converter plugins like signalk-n2kais-to-nmea0183, which NMEA 2000 input no longer needs. If the same receiver reaches two of these events, every message counts twice.',
      items: { type: 'string' },
      uniqueItems: true,
      default: DEFAULT_CONFIG.sentenceEvents,
    },
  },
}

function num(
  value: unknown,
  fallback: number,
  min: number,
  max = Infinity,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function resolveConfig(options: unknown): Config {
  const o = (options && typeof options === 'object' ? options : {}) as Record<
    string,
    unknown
  >
  const d = DEFAULT_CONFIG
  return {
    targetExpirySeconds: num(o.targetExpirySeconds, d.targetExpirySeconds, 60),
    h3Resolution: Math.round(num(o.h3Resolution, d.h3Resolution, 3, 8)),
    coverageDistancePercentile: num(
      o.coverageDistancePercentile,
      d.coverageDistancePercentile,
      50,
      100,
    ),
    ownPositionMaxAgeSeconds: num(
      o.ownPositionMaxAgeSeconds,
      d.ownPositionMaxAgeSeconds,
      1,
    ),
    coverageRetentionDays: Math.round(
      num(o.coverageRetentionDays, d.coverageRetentionDays, 1),
    ),
    publishIntervalMinutes: interval(
      o.publishIntervalMinutes,
      d.publishIntervalMinutes,
    ),
    publishOverlay:
      typeof o.publishOverlay === 'boolean'
        ? o.publishOverlay
        : d.publishOverlay,
    sentenceEvents: Array.isArray(o.sentenceEvents)
      ? [
          ...new Set(
            o.sentenceEvents
              .filter((e): e is string => typeof e === 'string')
              .map((e) => e.trim())
              .filter((e) => e !== ''),
          ),
        ]
      : [...d.sentenceEvents],
  }
}
