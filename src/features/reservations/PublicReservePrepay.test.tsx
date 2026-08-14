import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { t } from '../../lib/i18n'
import {
  ZONE_INSIDE, makeInfo, makeView, renderReservePage, slots,
} from './publicReserveHarness'

/**
 * Предоплата (164) на гостевой стороне.
 *
 * Главное свойство: экран оплаты недостижим, пока сервер не прислал
 * правило, а правило он присылает только при живом провайдере. Плюс ни
 * одна дорога отсюда не показывает «оплачено» без подтверждения сервера.
 */

vi.mock('./publicReserveApi', async () => {
  const actual = await vi.importActual<typeof import('./publicReserveApi')>('./publicReserveApi')
  return {
    ...actual,
    fetchReserveInfo: vi.fn(),
    fetchAvailability: vi.fn(),
    submitPublicReservation: vi.fn(),
    fetchReservationView: vi.fn(),
    beginReservationPrepayment: vi.fn(),
  }
})
vi.mock('./funnel', () => ({
  trackReserveStep: vi.fn(),
  resetFunnelSession: vi.fn(),
}))

const api = await import('./publicReserveApi')
const mocked = vi.mocked(api)

const NOW = new Date('2027-03-14T08:00:00.000Z')
const ZONES = [{ id: ZONE_INSIDE, name: 'בפנים' }]

/** Правило, которое сервер шлёт только при здоровом провайдере */
const RULE = {
  amount_per_guest: 5000, // 50 ₪ в агоротах
  from_party: 2,
  currency: 'ILS',
  refund_cutoff_hours: 24,
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  localStorage.clear()
  mocked.fetchAvailability.mockResolvedValue(slots(['12:00', '12:30']))
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function gotoDetails(info: ReturnType<typeof makeInfo>) {
  mocked.fetchReserveInfo.mockResolvedValue(info)
  renderReservePage()
  await screen.findByRole('heading', { name: 'Bulochka' })
  fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvShowTimes') }))
  await screen.findByRole('button', { name: /^12:00/ })
  fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvContinue') }))
  await screen.findByRole('heading', { name: t('he', 'rsvDetailsHeading') })
  fireEvent.change(screen.getByLabelText(t('he', 'rsvFirstName')), { target: { value: 'וולד' } })
  fireEvent.change(screen.getByLabelText(t('he', 'rsvLastName')), { target: { value: 'אנוטוב' } })
  fireEvent.change(screen.getByLabelText(t('he', 'rsvPhone')), { target: { value: '0541234567' } })
  fireEvent.change(screen.getByLabelText(t('he', 'rsvEmail')), { target: { value: 'g@example.com' } })
}

describe('без живого провайдера шага оплаты не существует', () => {
  it('сервер не прислал правило — форма завершается обычной бронью', async () => {
    mocked.submitPublicReservation.mockResolvedValue({
      reservation_id: '44444444-4444-4444-8444-444444444444',
      duplicate: false, status: 'confirmed',
      public_token: '55555555-5555-4555-8555-555555555555',
    })
    mocked.fetchReservationView.mockResolvedValue(makeView({ status: 'new' }))

    await gotoDetails(makeInfo({ zones: ZONES, prepay: null }))

    // Кнопка ведёт к подтверждению, а не к оплате
    expect(screen.getByRole('button', { name: t('he', 'rsvConfirmBooking') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('he', 'rsvToPrepay') })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvConfirmBooking') }))
    await waitFor(() => expect(mocked.submitPublicReservation).toHaveBeenCalled())
    expect(mocked.beginReservationPrepayment).not.toHaveBeenCalled()
  })

  it('полоса шагов не считает пропущенную оплату', async () => {
    await gotoDetails(makeInfo({ zones: ZONES, prepay: null }))
    const progress = screen.getByRole('progressbar')
    expect(progress).toHaveAttribute('aria-valuemax', '2')
  })
})

describe('правило есть — шаг оплаты появляется ПОСЛЕ контактов', () => {
  it('кнопка контактов ведёт к условиям предоплаты, бронь ещё не создана', async () => {
    await gotoDetails(makeInfo({ zones: ZONES, prepay: RULE }))

    const cta = screen.getByRole('button', { name: t('he', 'rsvToPrepay') })
    expect(cta).toBeInTheDocument()
    fireEvent.click(cta)

    await screen.findByRole('heading', { name: t('he', 'rsvPrepayTitle') })
    // Обычная заявка отсюда НЕ уходит: сначала платят
    expect(mocked.submitPublicReservation).not.toHaveBeenCalled()
  })

  it('полоса шагов считает оплату отдельным делением', async () => {
    await gotoDetails(makeInfo({ zones: ZONES, prepay: RULE }))
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvToPrepay') }))
    await screen.findByRole('heading', { name: t('he', 'rsvPrepayTitle') })

    const progress = screen.getByRole('progressbar')
    expect(progress).toHaveAttribute('aria-valuemax', '3')
    expect(progress).toHaveAttribute('aria-valuenow', '3')
  })

  it('компания меньше порога предоплату не платит', async () => {
    // Порог — от двух гостей; ставим одного
    mocked.fetchReserveInfo.mockResolvedValue(makeInfo({ zones: ZONES, prepay: RULE }))
    renderReservePage()
    await screen.findByRole('heading', { name: 'Bulochka' })
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvPartyMinus') }))
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvShowTimes') }))
    await screen.findByRole('button', { name: /^12:00/ })
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvContinue') }))
    await screen.findByRole('heading', { name: t('he', 'rsvDetailsHeading') })

    expect(screen.getByRole('button', { name: t('he', 'rsvConfirmBooking') })).toBeInTheDocument()
  })
})

describe('экран условий', () => {
  async function gotoPrepay() {
    await gotoDetails(makeInfo({ zones: ZONES, prepay: RULE }))
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvToPrepay') }))
    await screen.findByRole('heading', { name: t('he', 'rsvPrepayTitle') })
  }

  it('суммы показаны по серверной ставке: с гостя и итог', async () => {
    await gotoPrepay()
    const amount = document.querySelector('.public-reserve-prepay-amount')!
    // 50 ₪ с гостя, двое гостей → 100 ₪
    expect(amount.textContent).toContain('50')
    expect(amount.textContent).toContain('100')
  })

  it('у заголовка нет значка валюты', async () => {
    await gotoPrepay()
    const heading = screen.getByRole('heading', { name: t('he', 'rsvPrepayTitle') })
    expect(heading.textContent).not.toContain('₪')
  })

  it('без согласия платить нельзя, и причина названа', async () => {
    await gotoPrepay()
    const pay = screen.getByRole('button', { name: t('he', 'rsvPrepayCta') })
    expect(pay).toBeDisabled()
    expect(screen.getByText(t('he', 'rsvPrepayConsentNeed'))).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(pay).toBeEnabled()
  })

  it('срок бесплатной отмены и потеря денег написаны словами', async () => {
    await gotoPrepay()
    expect(screen.getByText(new RegExp(t('he', 'rsvPrepayForfeit')))).toBeInTheDocument()
    expect(document.body.textContent).toContain('24')
  })

  it('назад с оплаты возвращает на контакты, не потеряв их', async () => {
    await gotoPrepay()
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvBackToSlot') }))
    await screen.findByRole('heading', { name: t('he', 'rsvDetailsHeading') })
    expect(screen.getByLabelText(t('he', 'rsvFirstName'))).toHaveValue('וולד')
    expect(screen.getByLabelText(t('he', 'rsvEmail'))).toHaveValue('g@example.com')
  })
})

describe('оплата не выдаётся за состоявшуюся', () => {
  async function payWith(impl: () => Promise<never> | Promise<unknown>) {
    await gotoDetails(makeInfo({ zones: ZONES, prepay: RULE }))
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvToPrepay') }))
    await screen.findByRole('heading', { name: t('he', 'rsvPrepayTitle') })
    mocked.beginReservationPrepayment.mockImplementation(impl as never)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvPrepayCta') }))
  }

  it('сервер ответил «платить негде» — гость видит это, а не успех', async () => {
    const { PublicApiError } = await vi.importActual<typeof import('../online/publicApi')>('../online/publicApi')
    await payWith(async () => { throw new PublicApiError('prepay_unavailable') })

    expect(await screen.findByText(t('he', 'rsvErrPrepayUnavailable'))).toBeInTheDocument()
    // Никакой подтверждённой брони на экране не появилось
    expect(screen.queryByText(t('he', 'rsvConfirmedTitle'))).not.toBeInTheDocument()
  })

  it('удержание истекло — просим выбрать время заново', async () => {
    const { PublicApiError } = await vi.importActual<typeof import('../online/publicApi')>('../online/publicApi')
    await payWith(async () => { throw new PublicApiError('hold_expired') })
    expect(await screen.findByText(t('he', 'rsvErrHoldExpired'))).toBeInTheDocument()
  })

  it('удержание создано, но платить негде — успех не рисуется', async () => {
    // Сервер удержал стол и не дал адреса оплаты: считать бронь готовой
    // на этом основании нельзя.
    await payWith(async () => ({
      attempt_key: '66666666-6666-4666-8666-000000000001',
      reservation_id: '44444444-4444-4444-8444-000000000001',
      amount_minor: 10000,
      currency: 'ILS',
      status: 'pending',
      expires_at: new Date(NOW.getTime() + 900_000).toISOString(),
      duplicate: false,
      redirect_url: null,
    }))

    expect(await screen.findByText(t('he', 'rsvPrepayUnavailable'))).toBeInTheDocument()
    expect(screen.queryByText(t('he', 'rsvConfirmedTitle'))).not.toBeInTheDocument()
  })

  it('повторное нажатие использует ТОТ ЖЕ ключ попытки', async () => {
    const { PublicApiError } = await vi.importActual<typeof import('../online/publicApi')>('../online/publicApi')
    await payWith(async () => { throw new PublicApiError('prepay_unavailable') })
    await screen.findByText(t('he', 'rsvErrPrepayUnavailable'))

    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvPrepayCta') }))
    await waitFor(() => {
      expect(mocked.beginReservationPrepayment.mock.calls.length).toBeGreaterThan(1)
    })
    const first = mocked.beginReservationPrepayment.mock.calls[0][0].attempt_key
    const second = mocked.beginReservationPrepayment.mock.calls[1][0].attempt_key
    // Иначе повтор создавал бы вторую бронь и второе списание
    expect(second).toBe(first)
  })
})
