// Minimal typing for the parts of ggencoder this plugin uses.
declare module 'ggencoder' {
  export interface AisDecoded {
    valid: boolean
    error: string
    aistype?: number
    mmsi?: string
    class?: string
    lat?: number
    lon?: number
    cargo?: number
    part?: number
  }
  export const AisDecode: new (
    sentence: string,
    session?: Record<string, unknown>,
  ) => AisDecoded
  export const AisEncode: new (msg: Record<string, unknown>) => {
    valid: boolean
    nmea: string
  }
}
