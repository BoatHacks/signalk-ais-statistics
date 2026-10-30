// Synthetic AIS PGNs shaped as the server's canboatjs emits them on
// N2KAnalyzerOut: camelCase field ids, MMSIs as strings and lookup fields as
// canboat names. MMSIs use the unallocated 999 MID, as in ./ais.

export interface Pgn {
  pgn: number
  src: number
  fields: Record<string, unknown>
}

export function classAPgn(
  mmsi: number,
  lat: number | undefined,
  lon: number | undefined,
  transceiver = 'Channel A VDL reception',
): Pgn {
  return {
    pgn: 129038,
    src: 43,
    fields: {
      messageId: 'Scheduled Class A position report',
      repeatIndicator: 'Initial',
      userId: String(mmsi),
      longitude: lon,
      latitude: lat,
      sog: 2.5,
      aisTransceiverInformation: transceiver,
    },
  }
}

export function classBPgn(mmsi: number, lat: number, lon: number): Pgn {
  return {
    pgn: 129039,
    src: 43,
    fields: {
      messageId: 'Standard Class B position report',
      userId: String(mmsi),
      longitude: lon,
      latitude: lat,
      aisTransceiverInformation: 'Channel B VDL reception',
    },
  }
}

export function staticAPgn(mmsi: number, typeOfShip: string | number): Pgn {
  return {
    pgn: 129794,
    src: 43,
    fields: {
      messageId: 'Static and voyage related data',
      userId: String(mmsi),
      name: 'SYNTHETIC',
      typeOfShip,
      aisTransceiverInformation: 'Channel A VDL reception',
    },
  }
}

export function staticBPartBPgn(mmsi: number, typeOfShip: string): Pgn {
  return {
    pgn: 129810,
    src: 43,
    fields: {
      messageId: 'Static data report',
      userId: String(mmsi),
      typeOfShip,
      aisTransceiverInformation: 'Channel A VDL reception',
    },
  }
}
