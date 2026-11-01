// A small seeded random generator (mulberry32) for property style tests, so
// every run checks the same cases and a failure can be replayed.

export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Distances in nm spread over every bin, overflow included, on a log scale. */
export function distances(rand: () => number, n: number): number[] {
  return Array.from({ length: n }, () => {
    const r = rand()
    if (r < 0.03) return rand() * 0.5
    if (r > 0.99) return 512 + rand() * 4000
    return 0.5 * 2 ** (rand() * 10)
  })
}
