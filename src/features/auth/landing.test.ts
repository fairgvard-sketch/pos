import { describe, it, expect, beforeEach } from 'vitest'
import { landingRoute } from './landing'
import { useDeviceStore } from '../../store/deviceStore'

/**
 * P5: per-device стартовый экран влияет на посадку после PIN,
 * но 'hall' валиден только в режиме со столами.
 */

beforeEach(() => {
  useDeviceStore.setState({ startScreen: 'sell' })
})

describe('landingRoute с per-device стартовым экраном', () => {
  it('дефолт по режиму: tables → /hall, иначе /sell', () => {
    useDeviceStore.setState({ startScreen: 'sell' })
    expect(landingRoute('tables')).toBe('/sell') // явный выбор sell перебивает
    useDeviceStore.setState({ startScreen: 'hall' })
    expect(landingRoute('tables')).toBe('/hall')
  })

  it('startScreen=queue → /queue в любом режиме', () => {
    useDeviceStore.setState({ startScreen: 'queue' })
    expect(landingRoute('counter')).toBe('/queue')
    expect(landingRoute('tables')).toBe('/queue')
  })

  it('startScreen=hall игнорируется без режима столов (→ дефолт /sell)', () => {
    useDeviceStore.setState({ startScreen: 'hall' })
    expect(landingRoute('counter')).toBe('/sell')
  })

  it('startScreen=sell → /sell', () => {
    useDeviceStore.setState({ startScreen: 'sell' })
    expect(landingRoute('counter')).toBe('/sell')
  })
})
