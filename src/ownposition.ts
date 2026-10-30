// Latest own position and its age (ARCHITECTURE 2.2). Pure state.

export interface LatLon {
  lat: number
  lon: number
}

export class OwnPosition {
  private latest?: LatLon & { time: number }

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
    this.latest = { lat: latitude, lon: longitude, time }
  }

  /** The own position at `time`, or undefined when unknown or stale. */
  at(time: number): LatLon | undefined {
    if (!this.latest) return undefined
    const age = time - this.latest.time
    if (age > this.maxAgeMs || age < -this.maxAgeMs) return undefined
    return { lat: this.latest.lat, lon: this.latest.lon }
  }

  /** The last known own position regardless of age. */
  last(): LatLon | undefined {
    return this.latest
      ? { lat: this.latest.lat, lon: this.latest.lon }
      : undefined
  }

  /** Age in milliseconds of the last known position, if any. */
  ageMs(time: number): number | undefined {
    return this.latest ? time - this.latest.time : undefined
  }
}
