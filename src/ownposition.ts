// Latest own position and its age (ARCHITECTURE 2.2). Pure state.

export interface LatLon {
  lat: number
  lon: number
}

export class OwnPosition {
  private last?: LatLon & { time: number }

  constructor(private maxAgeMs: number) {}

  update(position: unknown, time: number): void {
    if (!position || typeof position !== 'object') return
    const { latitude, longitude } = position as Record<string, unknown>
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      return
    this.last = { lat: latitude, lon: longitude, time }
  }

  /** The own position at `time`, or undefined when unknown or stale. */
  at(time: number): LatLon | undefined {
    if (!this.last) return undefined
    const age = time - this.last.time
    if (age > this.maxAgeMs || age < -this.maxAgeMs) return undefined
    return { lat: this.last.lat, lon: this.last.lon }
  }

  /** Age in milliseconds of the last known position, if any. */
  ageMs(time: number): number | undefined {
    return this.last ? time - this.last.time : undefined
  }
}
