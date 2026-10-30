// Times are shown in ship time without a zone when the vessel publishes
// `environment.time.timezoneOffset`, otherwise in UTC with a Z. Dates are
// YYYY-MM-DD.

/** `(-)hhmm` as published by SignalK, in minutes east of UTC. */
export function parseOffset(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
  const a = Math.abs(Math.trunc(n))
  return Math.sign(n) * (Math.floor(a / 100) * 60 + (a % 100))
}

const pad = (n: number) => String(n).padStart(2, '0')

function shifted(ms: number, offsetMin: number | undefined): Date {
  return new Date(ms + (offsetMin ?? 0) * 60_000)
}

export function formatTime(ms: number, offsetMin: number | undefined): string {
  const d = shifted(ms, offsetMin)
  const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return offsetMin === undefined ? `${t}Z` : t
}

export function formatDate(ms: number, offsetMin: number | undefined): string {
  const d = shifted(ms, offsetMin)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function formatDateTime(
  ms: number,
  offsetMin: number | undefined,
): string {
  return `${formatDate(ms, offsetMin)} ${formatTime(ms, offsetMin)}`
}
