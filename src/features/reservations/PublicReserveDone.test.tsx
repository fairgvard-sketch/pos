import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { t } from '../../lib/i18n'
import { LOC, makeInfo, makeView, renderReservePage } from './publicReserveHarness'

/**
 * Экран брони по постоянной ссылке (118) в новом оформлении.
 *
 * Два свойства важнее вида: заявка и подтверждённая бронь названы РАЗНЫМИ
 * словами, а «предоплата внесена» показывается только тогда, когда это
 * подтвердил сервер.
 */

vi.mock('./publicReserveApi', async () => {
  const actual = await vi.importActual<typeof import('./publicReserveApi')>('./publicReserveApi')
  return {
    ...actual,
    fetchReserveInfo: vi.fn(),
    fetchAvailability: vi.fn(),
    fetchReservationView: vi.fn(),
    cancelPublicReservation: vi.fn(),
  }
})
vi.mock('./funnel', () => ({
  trackReserveStep: vi.fn(),
  resetFunnelSession: vi.fn(),
}))

const api = await import('./publicReserveApi')
const mocked = vi.mocked(api)

const TOKEN = '55555555-5555-4555-8555-555555555555'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2027-03-14T08:00:00.000Z'))
  localStorage.clear()
  mocked.fetchReserveInfo.mockResolvedValue(makeInfo())
  // Гость уже забронировал: ключ лежит в хранилище, как после отправки
  localStorage.setItem(
    'kassa-public-reserve',
    JSON.stringify({ clientUuid: TOKEN, locId: LOC }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('подтверждённая бронь', () => {
  it('показывает билет: дату, время и число гостей', async () => {
    mocked.fetchReservationView.mockResolvedValue(makeView())
    renderReservePage()

    await screen.findByText(t('he', 'rsvConfirmedTitle'))
    const ticket = document.querySelector('.public-reserve-ticket-grid')!
    expect(ticket.textContent).toContain(t('he', 'rsvTicketDate'))
    expect(ticket.textContent).toContain(t('he', 'rsvTicketTime'))
    expect(ticket.textContent).toContain('12:00') // 10:00 UTC в Иерусалиме
    expect(ticket.textContent).toContain('2')
  })

  it('даёт календарь, маршрут, звонок, меню и самообслуживание', async () => {
    mocked.fetchReservationView.mockResolvedValue(makeView())
    renderReservePage()
    await screen.findByText(t('he', 'rsvConfirmedTitle'))

    expect(screen.getByRole('button', { name: new RegExp(t('he', 'rsvAddToCalendar')) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(t('he', 'rsvNavigateBtn')) })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: new RegExp(t('he', 'rsvPhoneBtn')) })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: t('he', 'rsvViewMenu') }))
      .toHaveAttribute('href', `/order/${LOC}`)
    // Самообслуживание (118) не потеряно
    expect(screen.getByRole('button', { name: t('he', 'rsvReschedule') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('he', 'rsvCancelAction') })).toBeInTheDocument()
  })

  it('запрет сервера объяснён словами, а не мёртвой кнопкой', async () => {
    mocked.fetchReservationView.mockResolvedValue(makeView({
      can_cancel: false, cancel_block: 'too_late', can_reschedule: false,
    }))
    renderReservePage()
    await screen.findByText(t('he', 'rsvConfirmedTitle'))

    expect(screen.queryByRole('button', { name: t('he', 'rsvCancelAction') })).not.toBeInTheDocument()
    expect(screen.getByText(t('he', 'rsvBlockTooLate'))).toBeInTheDocument()
  })
})

describe('заявка, которую ещё не подтвердили', () => {
  it('называется ожиданием, а не подтверждённой бронью', async () => {
    mocked.fetchReservationView.mockResolvedValue(makeView({ status: 'new' }))
    renderReservePage()

    expect(await screen.findByText(t('he', 'rsvPendingTitle'))).toBeInTheDocument()
    expect(screen.queryByText(t('he', 'rsvConfirmedTitle'))).not.toBeInTheDocument()
    // Календарь ещё нечего добавлять: визита может не быть
    expect(screen.queryByRole('button', { name: new RegExp(t('he', 'rsvAddToCalendar')) }))
      .not.toBeInTheDocument()
  })
})

describe('предоплата в карточке', () => {
  it('«внесена» показывается ТОЛЬКО при подтверждённой оплате', async () => {
    mocked.fetchReservationView.mockResolvedValue(makeView({ deposit_status: 'paid' }))
    renderReservePage()
    await screen.findByText(t('he', 'rsvConfirmedTitle'))
    expect(screen.getByText(t('he', 'rsvPaidLabel'))).toBeInTheDocument()
  })

  it('«требуется» и «ждём оплату» подтверждением не считаются', async () => {
    for (const status of ['required', 'awaiting', 'failed'] as const) {
      mocked.fetchReservationView.mockResolvedValue(makeView({ deposit_status: status }))
      const { unmount } = renderReservePage()
      await screen.findByText(t('he', 'rsvConfirmedTitle'))
      expect(screen.queryByText(t('he', 'rsvPaidLabel'))).not.toBeInTheDocument()
      unmount()
    }
  })
})

describe('отменённая бронь', () => {
  it('предлагает забронировать заново', async () => {
    mocked.fetchReservationView.mockResolvedValue(makeView({ status: 'cancelled' }))
    renderReservePage()

    expect(await screen.findByText(t('he', 'rsvCancelledTitle'))).toBeInTheDocument()
    const again = screen.getByRole('button', { name: t('he', 'rsvNewAction') })
    fireEvent.click(again)

    // Возврат к первому экрану: имя перенесено, время и правила — нет
    await waitFor(() => {
      expect(screen.getByRole('button', { name: t('he', 'rsvShowTimes') })).toBeInTheDocument()
    })
  })
})
