import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { t } from '../../lib/i18n'
import {
  LOC, ZONE_INSIDE, ZONE_TERRACE, makeInfo, renderReservePage, slots,
} from './publicReserveHarness'

/**
 * Второй экран: зона зала выбирается ДО времени.
 *
 * Главное, что здесь проверяется, — невозможность показать время, которое
 * посчитано не для выбранного зала: запрос доступности обязан нести зону,
 * а ответ прошлой зоны не имеет права остаться на экране новой.
 */

vi.mock('./publicReserveApi', async () => {
  const actual = await vi.importActual<typeof import('./publicReserveApi')>('./publicReserveApi')
  return {
    ...actual,
    fetchReserveInfo: vi.fn(),
    fetchAvailability: vi.fn(),
    submitPublicReservation: vi.fn(),
    fetchReservationView: vi.fn(),
    joinWaitlist: vi.fn(),
  }
})
vi.mock('./funnel', () => ({
  trackReserveStep: vi.fn(),
  resetFunnelSession: vi.fn(),
}))

const api = await import('./publicReserveApi')
const mocked = vi.mocked(api)

const NOW = new Date('2027-03-14T08:00:00.000Z') // вс, 10:00 по Иерусалиму
const ZONES = [
  { id: ZONE_INSIDE, name: 'בפנים' },
  { id: ZONE_TERRACE, name: 'טרסה' },
]

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/** Открыть страницу и дойти до второго экрана */
async function gotoVisit(info = makeInfo({ zones: ZONES, slot_min: 30 })) {
  mocked.fetchReserveInfo.mockResolvedValue(info)
  renderReservePage()
  await screen.findByRole('heading', { name: 'Bulochka' })
  fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvShowTimes') }))
  await screen.findByRole('heading', { name: new RegExp(t('he', 'rsvVisitTitle')) })
}

/** Кнопка зоны именно из блока зон: имя зоны есть и в подписях времён */
function zoneButton(name: RegExp) {
  const zones = document.querySelector('.public-reserve-zones') as HTMLElement
  return within(zones).getByRole('button', { name })
}

describe('зона выбирается раньше времени', () => {
  it('запрос доступности несёт выбранную зону, а не «любой стол»', async () => {
    mocked.fetchAvailability.mockResolvedValue(slots(['12:00', '12:30', '13:00']))
    await gotoVisit()

    await waitFor(() => {
      expect(mocked.fetchAvailability).toHaveBeenCalledWith(
        LOC, expect.any(String), 2, ZONE_INSIDE,
      )
    })
  })

  it('первая зона выбрана заранее, а зоны стоят выше времён в разметке', async () => {
    mocked.fetchAvailability.mockResolvedValue(slots(['12:00', '12:30']))
    await gotoVisit()

    const inside = zoneButton(/בפנים/)
    expect(inside).toHaveAttribute('aria-pressed', 'true')

    await screen.findByRole('button', { name: /^12:00/ })
    const zonesBlock = document.querySelector('.public-reserve-zones')!
    const timesBlock = document.querySelector('.public-reserve-times')!
    // Зоны идут раньше времён в самом документе, а не только визуально
    expect(zonesBlock.compareDocumentPosition(timesBlock) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })

  it('смена зоны перезапрашивает доступность именно для новой зоны', async () => {
    mocked.fetchAvailability.mockImplementation(async (_l, _d, _p, zone) => (
      zone === ZONE_TERRACE
        ? slots(['19:00', '19:30'])
        : slots(['12:00', '12:30'])
    ))
    await gotoVisit()
    await screen.findByRole('button', { name: /12:00/ })

    fireEvent.click(zoneButton(/טרסה/))

    // Времена прошлой зоны исчезли, а не остались висеть рядом с новой
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /12:00/ })).not.toBeInTheDocument()
    })
    expect(await screen.findByRole('button', { name: /19:00/ })).toBeInTheDocument()
    expect(mocked.fetchAvailability).toHaveBeenCalledWith(LOC, expect.any(String), 2, ZONE_TERRACE)
  })

  it('выбор времени не переносится в зону, где оно занято', async () => {
    mocked.fetchAvailability.mockImplementation(async (_l, _d, _p, zone) => (
      zone === ZONE_TERRACE
        ? slots(['12:00', '12:30'], ['12:00']) // на террасе 12:00 занято
        : slots(['12:00', '12:30'])
    ))
    await gotoVisit()

    fireEvent.click(await screen.findByRole('button', { name: /^12:00/ }))
    expect(screen.getByRole('button', { name: t('he', 'rsvContinue') })).toBeEnabled()

    fireEvent.click(zoneButton(/טרסה/))

    // 12:00 на террасе занято → продолжить нельзя, пока не выбрано другое
    await waitFor(() => {
      expect(screen.getByRole('button', { name: t('he', 'rsvPickTimeFirst') })).toBeDisabled()
    })
  })
})

describe('состояния времени', () => {
  it('занятое время помечено словом, а не только цветом', async () => {
    mocked.fetchAvailability.mockResolvedValue(slots(['12:00', '12:30'], ['12:30']))
    await gotoVisit()

    const taken = await screen.findByRole('button', { name: /12:30/ })
    expect(taken).toHaveAttribute('aria-disabled', 'true')
    expect(taken.textContent).toContain(t('he', 'rsvSlotFull'))
  })

  it('пока доступность едет, мигает только область времён', async () => {
    let release: (v: unknown) => void = () => {}
    mocked.fetchAvailability.mockImplementation(
      () => new Promise((r) => { release = r }) as never
    )
    await gotoVisit()

    expect(document.querySelectorAll('.public-reserve-time-skeleton').length).toBeGreaterThan(0)
    // Зоны и сводка на месте — экран целиком не пересобирается
    expect(zoneButton(/בפנים/)).toBeInTheDocument()

    release(slots(['12:00']))
    await waitFor(() => {
      expect(document.querySelectorAll('.public-reserve-time-skeleton')).toHaveLength(0)
    })
  })

  it('время предвыбрано, и тап переносит выбор на другое свободное', async () => {
    mocked.fetchAvailability.mockResolvedValue(slots(['12:00', '12:30']))
    await gotoVisit()
    const noon = await screen.findByRole('button', { name: /^12:00/ })

    // Референс открывает экран с уже выбранным временем — гостю остаётся
    // подтвердить, а не искать, куда нажать.
    expect(noon).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: t('he', 'rsvContinue') })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: /^12:30/ }))
    expect(screen.getByRole('button', { name: /^12:30/ })).toHaveAttribute('aria-pressed', 'true')
    expect(noon).toHaveAttribute('aria-pressed', 'false')
  })

  it('без единого свободного времени кнопка «дальше» выключена', async () => {
    // По всей точке место есть (иначе первый экран не пустит дальше),
    // а в выбранном зале — нет.
    mocked.fetchAvailability.mockImplementation(async (_l, _d, _p, zone) => (
      zone === ZONE_INSIDE
        ? slots(['12:00', '12:30'], ['12:00', '12:30'])
        : slots(['12:00', '12:30'])
    ))
    await gotoVisit()
    await screen.findByText(t('he', 'rsvZoneFull'))
    expect(screen.getByRole('button', { name: t('he', 'rsvPickTimeFirst') })).toBeDisabled()
  })
})

describe('время занято', () => {
  it('тап по занятому времени объясняет и предлагает ближайшее в ТОЙ ЖЕ зоне', async () => {
    mocked.fetchAvailability.mockResolvedValue(
      slots(['12:00', '12:30', '13:00'], ['12:30'])
    )
    await gotoVisit()

    fireEvent.click(await screen.findByRole('button', { name: /12:30/ }))

    expect(await screen.findByText(new RegExp(t('he', 'rsvUnavailableTitle')))).toBeInTheDocument()
    const alternatives = document.querySelector('.public-reserve-alternatives')!
    // Ближайшее раньше и позже — из той же зоны, зона молча не меняется
    expect(within(alternatives as HTMLElement).getByText('12:00')).toBeInTheDocument()
    expect(within(alternatives as HTMLElement).getByText('13:00')).toBeInTheDocument()
  })

  it('лист ожидания предлагается, только если владелец его включил', async () => {
    mocked.fetchAvailability.mockResolvedValue(slots(['12:00', '12:30'], ['12:30']))
    await gotoVisit(makeInfo({ zones: ZONES, waitlist: false }))
    fireEvent.click(await screen.findByRole('button', { name: /12:30/ }))
    await screen.findByText(new RegExp(t('he', 'rsvUnavailableTitle')))
    expect(screen.queryByRole('button', { name: t('he', 'rsvWaitlistSubmit') }))
      .not.toBeInTheDocument()
  })

  it('с включённым листом ожидания кнопка есть', async () => {
    mocked.fetchAvailability.mockResolvedValue(slots(['12:00', '12:30'], ['12:30']))
    await gotoVisit(makeInfo({ zones: ZONES, waitlist: true }))
    fireEvent.click(await screen.findByRole('button', { name: /12:30/ }))
    await screen.findByText(new RegExp(t('he', 'rsvUnavailableTitle')))
    expect(screen.getByRole('button', { name: t('he', 'rsvWaitlistSubmit') })).toBeInTheDocument()
  })

  it('зона занята целиком — честное объяснение вместо пустой сетки', async () => {
    mocked.fetchAvailability.mockImplementation(async (_l, _d, _p, zone) => (
      zone === ZONE_INSIDE
        ? slots(['12:00', '12:30'], ['12:00', '12:30'])
        : slots(['12:00', '12:30'])
    ))
    await gotoVisit()
    expect(await screen.findByText(t('he', 'rsvZoneFull'))).toBeInTheDocument()
    // Зона гостя не подменяется молча на ту, где место есть
    expect(zoneButton(/בפנים/)).toHaveAttribute('aria-pressed', 'true')
  })

  it('ошибку доступности показываем, а не выдаём занятость за свободу', async () => {
    mocked.fetchAvailability.mockRejectedValue(new Error('boom'))
    await gotoVisit()
    expect(await screen.findByText(t('he', 'rsvErrAvailability'))).toBeInTheDocument()
  })
})

describe('точка без зон', () => {
  it('зоны не показываются, доступность спрашивается «по всей точке»', async () => {
    mocked.fetchAvailability.mockResolvedValue(slots(['12:00', '12:30']))
    await gotoVisit(makeInfo({ zones: [] }))

    expect(screen.queryByText(t('he', 'rsvZoneQuestion'))).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mocked.fetchAvailability).toHaveBeenCalledWith(LOC, expect.any(String), 2, null)
    })
  })
})

describe('возврат назад', () => {
  it('«изменить» возвращает к дате и числу гостей, сохраняя их', async () => {
    mocked.fetchAvailability.mockResolvedValue(slots(['12:00']))
    await gotoVisit()

    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvChangeSelection') }))

    // Первый экран снова на месте, компания прежняя
    await screen.findByRole('button', { name: t('he', 'rsvShowTimes') })
    expect(document.querySelector('.public-reserve-stepper strong')?.textContent).toBe('2')
  })
})

describe('полоса шагов', () => {
  it('экран зоны и времени — ПЕРВЫЙ шаг потока, а не второй', async () => {
    mocked.fetchAvailability.mockResolvedValue(slots(['12:00']))
    await gotoVisit(makeInfo({ zones: ZONES, rules: [] }))

    const progress = screen.getByRole('progressbar')
    // Без правил и предоплаты весь путь — два экрана, и это первый
    expect(progress).toHaveAttribute('aria-valuenow', '1')
    expect(progress).toHaveAttribute('aria-valuemax', '2')
  })

  it('с правилами делений становится три, номер шага прежний', async () => {
    mocked.fetchAvailability.mockResolvedValue(slots(['12:00']))
    await gotoVisit(makeInfo({
      zones: ZONES,
      rules: [{ id: 'a', text: 'условие', level: 'normal', ack: false, url: null }],
    }))

    const progress = screen.getByRole('progressbar')
    expect(progress).toHaveAttribute('aria-valuenow', '1')
    expect(progress).toHaveAttribute('aria-valuemax', '3')
  })
})
