import { describe, expect, it } from 'vitest'
import { HttpError } from '../../web/src/api'
import { canSave, capLabel, saveError } from '../../web/src/settings'

describe('live settings in the web app', () => {
  it('offers saving to readwrite and admin users, and to all without security', () => {
    expect(
      canSave({ authenticationRequired: false, status: 'notLoggedIn' }),
    ).toBe(true)
    for (const userLevel of ['readwrite', 'admin'])
      expect(
        canSave({
          authenticationRequired: true,
          status: 'loggedIn',
          userLevel,
        }),
      ).toBe(true)
    expect(
      canSave({
        authenticationRequired: true,
        status: 'loggedIn',
        userLevel: 'readonly',
      }),
    ).toBe(false)
    expect(
      canSave({ authenticationRequired: true, status: 'notLoggedIn' }),
    ).toBe(false)
    expect(canSave({})).toBe(false)
    expect(canSave(undefined)).toBe(false)
  })

  it('names the cap percentile, or off at 100', () => {
    expect(capLabel(99)).toBe('99th percentile')
    expect(capLabel(91)).toBe('91st percentile')
    expect(capLabel(92)).toBe('92nd percentile')
    expect(capLabel(53)).toBe('53rd percentile')
    expect(capLabel(100)).toBe('off')
  })

  it('explains a refused save', () => {
    expect(saveError(new HttpError(403, 'Forbidden'))).toMatch(
      /readwrite or admin/,
    )
    expect(saveError(new HttpError(503, 'x'))).toMatch(/not running/)
    expect(saveError(new HttpError(400, 'bad'))).toBe('Could not save: bad')
  })
})
