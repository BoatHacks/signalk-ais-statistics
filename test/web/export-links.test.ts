import { describe, expect, it } from 'vitest'
import { exportHref } from '../../web/src/api'

describe('export links', () => {
  it('names the window and leaves flags that are off out', () => {
    expect(exportHref('coverage.csv', '7d')).toBe(
      '/plugins/signalk-ais-statistics/export/coverage.csv?window=7d',
    )
    expect(exportHref('coverage.csv', 'all', { all: true })).toBe(
      '/plugins/signalk-ais-statistics/export/coverage.csv?window=all&all=true',
    )
    expect(
      exportHref('longrange.csv', '24h', { anonymise: true, all: false }),
    ).toBe(
      '/plugins/signalk-ais-statistics/export/longrange.csv?window=24h&anonymise=true',
    )
  })
})
