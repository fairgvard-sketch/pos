import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { t } from '../../lib/i18n'
import {
  LOC, makeInfo, renderReservePage, slots,
} from './publicReserveHarness'

/**
 * Первый экран брони по утверждённому референсу.
 *
 * Проверяется то, что легко сломать правкой вёрстки и невозможно заметить
 * в юнит-тесте функции: порядок «дата → гости», пределы степпера, лист
 * заведения с фокусом и отсутствие устаревшей чёрной плашки соцсетей.
 */

vi.mock('./publicReserveApi', async () => {
  const actual = await vi.importActual<typeof import('./publicReserveApi')>('./publicReserveApi')
  return {
    ...actual,
    fetchReserveInfo: vi.fn(),
    fetchAvailability: vi.fn(),
    submitPublicReservation: vi.fn(),
    fetchReservationView: vi.fn(),
  }
})
// Телеметрия не должна ходить в сеть из тестов и ничего здесь не решает
vi.mock('./funnel', () => ({
  trackReserveStep: vi.fn(),
  resetFunnelSession: vi.fn(),
}))

const api = await import('./publicReserveApi')
const mocked = vi.mocked(api)

// «Сейчас» фиксировано: 2027-03-14 — воскресенье, точка открыта 08:00–20:00
const NOW = new Date('2027-03-14T08:00:00.000Z') // 10:00 по Иерусалиму

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  localStorage.clear()
  mocked.fetchAvailability.mockResolvedValue(
    slots(['12:00', '12:30', '13:00', '19:00', '19:30'])
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function openEntry(info = makeInfo()) {
  mocked.fetchReserveInfo.mockResolvedValue(info)
  const view = renderReservePage()
  await screen.findByRole('heading', { name: 'Bulochka' })
  return view
}

describe('первый экран: структура', () => {
  it('дата стоит ВЫШЕ числа гостей', async () => {
    await openEntry()
    const boxes = document.querySelectorAll('.public-reserve-quick-box')
    expect(boxes).toHaveLength(2)
    // У даты подписи нет: «сегодня» и так читается датой, а место отдано
    // самому значению. Опознаём строку по её select-у.
    expect(boxes[0].querySelector('select')).toBeTruthy()
    expect(boxes[0].textContent).toContain(t('he', 'today'))
    expect(boxes[1].textContent).toContain(t('he', 'rsvEntryPartyLabel'))
  })

  it('шеврон даты стоит у дальнего края строки, а не вплотную к цифрам', async () => {
    await openEntry()
    const box = document.querySelector('.public-reserve-quick-box')!
    const value = box.querySelector('.public-reserve-quick-value')!
    const chevron = box.querySelector('.public-reserve-quick-chevron')!
    // Значение идёт первым, шеврон — последним: space-between разводит их
    // по краям, и стрелка относится ко всей строке, а не к числу
    expect(value.compareDocumentPosition(chevron) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })

  it('название и адрес заведения стоят рядом, время на экране не выбирается', async () => {
    await openEntry()
    expect(screen.getByRole('heading', { name: 'Bulochka' })).toBeInTheDocument()
    expect(screen.getByText('פינסקר 29, תל אביב')).toBeInTheDocument()
    // Время переехало на второй экран: доступность зависит от зоны зала
    expect(screen.queryByLabelText(t('he', 'rsvTime'))).not.toBeInTheDocument()
  })

  it('логотип лежит на шве фото и листа, кнопка меню ведёт в меню той же точки', async () => {
    await openEntry()
    expect(document.querySelector('.public-reserve-entry-logo')).toBeInTheDocument()
    expect(document.querySelector('.public-reserve-entry-sheet.has-logo')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: t('he', 'rsvMenuLink') }))
      .toHaveAttribute('href', `/order/${LOC}`)
  })

  it('постоянной чёрной плашки соцсетей больше нет', async () => {
    await openEntry(makeInfo({
      links: { instagram: 'https://instagram.com/x', facebook: null, google_review: null },
    }))
    // Соцсети живут в листе заведения, а не под формой
    expect(screen.queryByRole('link', { name: 'Instagram' })).not.toBeInTheDocument()
  })
})

describe('первый экран: число гостей', () => {
  it('степпер меняет значение на ±1 и упирается в пределы точки', async () => {
    await openEntry(makeInfo({ max_party: 4 }))
    const minus = screen.getByRole('button', { name: t('he', 'rsvPartyMinus') })
    const plus = screen.getByRole('button', { name: t('he', 'rsvPartyPlus') })
    const value = () => document.querySelector('.public-reserve-stepper strong')?.textContent

    expect(value()).toBe('2')
    fireEvent.click(plus)
    expect(value()).toBe('3')
    fireEvent.click(minus)
    fireEvent.click(minus)
    expect(value()).toBe('1')
    // Нижний край: кнопка выключена, а не молча ничего не делает
    expect(minus).toBeDisabled()

    fireEvent.click(plus)
    fireEvent.click(plus)
    fireEvent.click(plus)
    expect(value()).toBe('4')
    expect(plus).toBeDisabled() // max_party точки
  })
})

describe('первый экран: дата', () => {
  it('закрытый день виден, но выбрать его нельзя', async () => {
    await openEntry()
    const select = screen.getByLabelText(t('he', 'rsvDate')) as HTMLSelectElement
    // 2027-03-20 — суббота, у «Булочки» шабат закрыт
    const saturday = Array.from(select.options).find((o) => o.value === '2027-03-20')
    expect(saturday).toBeDefined()
    expect(saturday!.disabled).toBe(true)
    const monday = Array.from(select.options).find((o) => o.value === '2027-03-15')
    expect(monday!.disabled).toBe(false)
  })
})

describe('лист заведения', () => {
  it('открывается из полосы часов и показывает неделю, адрес и соцсети', async () => {
    await openEntry(makeInfo({
      links: {
        instagram: 'https://instagram.com/x',
        facebook: 'https://facebook.com/x',
        google_review: null,
      },
    }))

    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvVenueHoursOpen') }))
    const sheet = await screen.findByRole('dialog', { name: t('he', 'rsvVenueSheetTitle') })

    expect(within(sheet).getByRole('link', { name: 'Instagram' }))
      .toHaveAttribute('href', 'https://instagram.com/x')
    expect(within(sheet).getByRole('link', { name: 'Facebook' })).toBeInTheDocument()
    // Пустой ссылки нет — кнопки тоже нет
    expect(within(sheet).queryByRole('link', { name: 'Google' })).not.toBeInTheDocument()
    // Внешние ссылки открываются безопасно
    expect(within(sheet).getByRole('link', { name: 'Instagram' }))
      .toHaveAttribute('rel', expect.stringContaining('noopener'))
    // Суббота показана закрытой
    expect(sheet.textContent).toContain(t('he', 'rsvDayClosed'))
    // Отдельной строки «сейчас открыто/закрыто» в списке нет: сегодняшний
    // день и так выделен, а вторая жирная строка с тем же интервалом
    // читалась как ещё одна запись расписания
    const hours = sheet.querySelector('.public-reserve-venue-hours')!
    expect(hours.textContent).not.toContain(t('he', 'rsvVenueOpenNow'))
    expect(hours.textContent).not.toContain(t('he', 'rsvVenueClosedNow'))
    expect(hours.querySelectorAll('[data-today="true"]').length).toBeLessThanOrEqual(1)
  })

  it('закрывается по Escape и возвращает фокус кнопке, которая его открыла', async () => {
    await openEntry()
    const opener = screen.getByRole('button', { name: t('he', 'rsvVenueHoursOpen') })
    // Браузер фокусирует кнопку при нажатии сам, jsdom — нет: без этого
    // тест проверял бы дыру jsdom, а не возврат фокуса.
    opener.focus()
    fireEvent.click(opener)
    await screen.findByRole('dialog', { name: t('he', 'rsvVenueSheetTitle') })

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('he', 'rsvVenueSheetTitle') }))
        .not.toBeInTheDocument()
    })
    // Фокус вернулся туда, откуда гость ушёл, а не на начало страницы
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('пока лист открыт, фон не прокручивается', async () => {
    await openEntry()
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvVenueHoursOpen') }))
    await screen.findByRole('dialog', { name: t('he', 'rsvVenueSheetTitle') })
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('«открыто сейчас» соответствует расписанию точки', async () => {
    await openEntry()
    // 10:00 по Иерусалиму в воскресенье — точка открыта
    expect(screen.getAllByText(t('he', 'rsvVenueOpenNow')).length).toBeGreaterThan(0)
  })
})

describe('полоса часов на первом экране', () => {
  /** Короткое имя дня недели так же, как его берёт страница — у Intl */
  const dayName = (dateStr: string) => new Date(`${dateStr}T12:00:00Z`)
    .toLocaleDateString('he-IL', { weekday: 'short', timeZone: 'UTC' })

  const strip = () => document.querySelector('.public-reserve-hours-copy > strong')!

  it('называет день и его интервал, а не один интервал', async () => {
    await openEntry()
    // Воскресенье 2027-03-14: «יום א׳ · 08:00–20:00»
    expect(strip().textContent).toContain(dayName('2027-03-14'))
    expect(strip().textContent).toContain('08:00–20:00')
  })

  it('в шабат пишет сам день, а не одинокое «закрыто»', async () => {
    // 2027-03-20 — суббота, у «Булочки» шабат закрыт
    vi.setSystemTime(new Date('2027-03-20T08:00:00.000Z'))
    await openEntry()
    expect(strip().textContent).toContain(dayName('2027-03-20'))
    expect(strip().textContent).toContain(t('he', 'rsvDayClosed'))
  })
})

describe('переход к выбору зала и времени', () => {
  it('кнопка ведёт на второй экран, а не сразу к времени без зоны', async () => {
    await openEntry()
    const cta = screen.getByRole('button', { name: t('he', 'rsvShowTimes') })
    expect(cta).toBeEnabled()
    fireEvent.click(cta)
    // Первый экран уступил место следующему шагу
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: t('he', 'rsvShowTimes') }))
        .not.toBeInTheDocument()
    })
  })
})
