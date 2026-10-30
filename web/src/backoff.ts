// Reconnect delay for the SignalK WebSocket: 1 s doubling to 60 s, with up
// to 20 percent jitter so many clients do not reconnect at once.
const BASE_MS = 1000
const MAX_MS = 60_000

export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(MAX_MS, BASE_MS * 2 ** attempt)
  return Math.min(MAX_MS, Math.round(base * (0.8 + 0.4 * random())))
}
