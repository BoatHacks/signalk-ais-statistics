// Class and type group from the message itself (SPEC 2.1). Nothing is
// filtered here; every decoded message is counted somewhere.
import type { TypeGroup } from './paths'

export type AisClass = 'A' | 'B' | 'other'

const CLASS_A_TYPES = new Set([1, 2, 3, 5])
const CLASS_B_TYPES = new Set([18, 19, 24])
const POSITION_REPORT_TYPES = new Set([1, 2, 3, 18, 19, 9])

/** Class from the message type, not from any vessel database. */
export function classOf(messageType: number): AisClass {
  if (CLASS_A_TYPES.has(messageType)) return 'A'
  if (CLASS_B_TYPES.has(messageType)) return 'B'
  return 'other'
}

/** Position reports per SPEC 1.3: types 1, 2, 3, 18, 19 and 9 (SAR aircraft). */
export function isPositionReport(messageType: number): boolean {
  return POSITION_REPORT_TYPES.has(messageType)
}

/**
 * Messages that identify a vessel for the unique vessel counts: those of
 * class A and B. Base stations, aids to navigation and SAR aircraft are not
 * vessels.
 */
export function isVesselMessage(messageType: number): boolean {
  return classOf(messageType) !== 'other'
}

/** Type group from the AIS ship type code (SPEC 2.1). */
export function typeGroup(shipType: number | undefined): TypeGroup {
  if (shipType === undefined) return 'unknown'
  if (shipType === 30) return 'fishing'
  if (shipType === 36 || shipType === 37) return 'pleasureCraft'
  if (shipType >= 60 && shipType <= 69) return 'passenger'
  if (shipType >= 70 && shipType <= 79) return 'cargo'
  if (shipType >= 80 && shipType <= 89) return 'tanker'
  return 'other'
}
