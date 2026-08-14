import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { t } from '../../lib/i18n'
import {
  ZONE_INSIDE, makeInfo, makeView, renderReservePage, rule, slots,
} from './publicReserveHarness'

/**
 * Правила и контакты гостя (163).
 *
 * Проверяется главное свойство контракта: на сервер уезжает и структурное
 * имя, и собранное `customer_name`. Собранное имя оставлено намеренно —
 * по нему живут касса, карточка гостя и выгрузки, и сервер, выложенный до
 * 163, других полей не знает.
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
vi.mock('./funnel', () => ({
  trackReserveStep: vi.fn(),
  resetFunnelSession: vi.fn(),
}))

const api = await import('./publicReserveApi')
const mocked = vi.mocked(api)

const NOW = new Date('2027-03-14T08:00:00.000Z')
const ZONES = [{ id: ZONE_INSIDE, name: 'בפנים' }]

const RULES = [
  rule({ id: 'hold', text: 'השולחן יישמר 15 דקות' }),
  rule({ id: 'terms', text: 'תנאי ההזמנה', ack: true, level: 'important', url: 'https://x.test/terms' }),
]

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  localStorage.clear()
  mocked.fetchAvailability.mockResolvedValue(slots(['12:00', '12:30']))
  mocked.submitPublicReservation.mockResolvedValue({
    reservation_id: '44444444-4444-4444-8444-444444444444',
    duplicate: false,
    status: 'confirmed',
    public_token: '55555555-5555-4555-8555-555555555555',
  })
  mocked.fetchReservationView.mockResolvedValue(makeView())
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/** Дойти до экрана контактов */
async function gotoDetails(info = makeInfo({ zones: ZONES })) {
  mocked.fetchReserveInfo.mockResolvedValue(info)
  renderReservePage()
  await screen.findByRole('heading', { name: 'Bulochka' })
  fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvShowTimes') }))
  await screen.findByRole('button', { name: /^12:00/ })
  fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvContinue') }))

  if ((info.location.rules ?? []).length > 0) {
    await screen.findByRole('heading', { name: t('he', 'rsvRulesTitle') })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvRulesContinue') }))
  }
  await screen.findByRole('heading', { name: t('he', 'rsvDetailsHeading') })
}

function fillDetails({
  first = 'וולד', last = 'אנוטוב', phone = '0541234567', email = 'guest@example.com',
} = {}) {
  fireEvent.change(screen.getByLabelText(t('he', 'rsvFirstName')), { target: { value: first } })
  fireEvent.change(screen.getByLabelText(t('he', 'rsvLastName')), { target: { value: last } })
  fireEvent.change(screen.getByLabelText(t('he', 'rsvPhone')), { target: { value: phone } })
  fireEvent.change(screen.getByLabelText(t('he', 'rsvEmail')), { target: { value: email } })
}

describe('структурное имя и почта уезжают на сервер', () => {
  it('в заявке есть и части имени, и собранное customer_name', async () => {
    await gotoDetails()
    fillDetails()
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvConfirmBooking') }))

    await waitFor(() => expect(mocked.submitPublicReservation).toHaveBeenCalled())
    expect(mocked.submitPublicReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        first_name: 'וולד',
        last_name: 'אנוטוב',
        email: 'guest@example.com',
        // Совместимость: старый сервер знает только это поле
        name: 'וולד אנוטוב',
        phone: '0541234567',
        zone_id: ZONE_INSIDE,
      })
    )
  })

  it('телефон уезжает только цифрами, как бы гость его ни записал', async () => {
    await gotoDetails()
    fillDetails({ phone: '+972 54-123-4567' })
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvConfirmBooking') }))

    await waitFor(() => expect(mocked.submitPublicReservation).toHaveBeenCalled())
    expect(mocked.submitPublicReservation.mock.calls[0][0].phone).toBe('972541234567')
  })

  it('отмеченные пожелания уходят в заметку, которую читает хостес', async () => {
    await gotoDetails()
    fillDetails()
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvExtraHighChair') }))
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvConfirmBooking') }))

    await waitFor(() => expect(mocked.submitPublicReservation).toHaveBeenCalled())
    expect(mocked.submitPublicReservation.mock.calls[0][0].note)
      .toContain(t('he', 'rsvExtraHighChair'))
  })
})

describe('проверка полей на экране', () => {
  it('пустая форма не отправляется, а показывает ошибки полей', async () => {
    await gotoDetails()
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvConfirmBooking') }))

    expect(mocked.submitPublicReservation).not.toHaveBeenCalled()
    expect(await screen.findByText(t('he', 'rsvErrFirstName'))).toBeInTheDocument()
    expect(screen.getByText(t('he', 'rsvErrLastName'))).toBeInTheDocument()
    expect(screen.getByText(t('he', 'rsvErrEmail'))).toBeInTheDocument()
  })

  it('битая почта не проходит', async () => {
    await gotoDetails()
    fillDetails({ email: 'guest@example' })
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvConfirmBooking') }))

    expect(mocked.submitPublicReservation).not.toHaveBeenCalled()
    expect(await screen.findByText(t('he', 'rsvErrEmail'))).toBeInTheDocument()
  })

  it('имя и фамилия — разные поля с разными autocomplete', async () => {
    await gotoDetails()
    expect(screen.getByLabelText(t('he', 'rsvFirstName')))
      .toHaveAttribute('autocomplete', 'given-name')
    expect(screen.getByLabelText(t('he', 'rsvLastName')))
      .toHaveAttribute('autocomplete', 'family-name')
    expect(screen.getByLabelText(t('he', 'rsvEmail'))).toHaveAttribute('type', 'email')
  })
})

describe('возврат назад не теряет набранное', () => {
  it('контакты переживают уход к времени и обратно', async () => {
    await gotoDetails()
    fillDetails()

    // Назад к выбору времени
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvBackToSlot') }))
    await screen.findByRole('heading', { name: new RegExp(t('he', 'rsvVisitTitle')) })
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvContinue') }))
    await screen.findByRole('heading', { name: t('he', 'rsvDetailsHeading') })

    expect(screen.getByLabelText(t('he', 'rsvFirstName'))).toHaveValue('וולד')
    expect(screen.getByLabelText(t('he', 'rsvLastName'))).toHaveValue('אנוטוב')
    expect(screen.getByLabelText(t('he', 'rsvPhone'))).toHaveValue('0541234567')
    expect(screen.getByLabelText(t('he', 'rsvEmail'))).toHaveValue('guest@example.com')
  })
})

describe('правила точки', () => {
  it('без правил шага нет, и полоса шагов считает два деления', async () => {
    await gotoDetails(makeInfo({ zones: ZONES, rules: [] }))
    const progress = screen.getByRole('progressbar')
    expect(progress).toHaveAttribute('aria-valuemax', '2')
    expect(progress).toHaveAttribute('aria-valuenow', '2')
  })

  it('с правилами шаг есть, и делений становится три', async () => {
    await gotoDetails(makeInfo({ zones: ZONES, rules: RULES }))
    const progress = screen.getByRole('progressbar')
    expect(progress).toHaveAttribute('aria-valuemax', '3')
    expect(progress).toHaveAttribute('aria-valuenow', '3')
  })

  it('обязательное правило нельзя обойти: кнопка выключена с объяснением', async () => {
    mocked.fetchReserveInfo.mockResolvedValue(makeInfo({ zones: ZONES, rules: RULES }))
    renderReservePage()
    await screen.findByRole('heading', { name: 'Bulochka' })
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvShowTimes') }))
    await screen.findByRole('button', { name: /^12:00/ })
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvContinue') }))
    await screen.findByRole('heading', { name: t('he', 'rsvRulesTitle') })

    const cta = screen.getByRole('button', { name: t('he', 'rsvRulesContinue') })
    expect(cta).toBeDisabled()
    // Гость видит причину, а не молча мёртвую кнопку
    expect(screen.getByText(t('he', 'rsvRulesNeedAck'))).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(cta).toBeEnabled()
  })

  it('ссылка в правиле открывается безопасно', async () => {
    mocked.fetchReserveInfo.mockResolvedValue(makeInfo({ zones: ZONES, rules: RULES }))
    renderReservePage()
    await screen.findByRole('heading', { name: 'Bulochka' })
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvShowTimes') }))
    await screen.findByRole('button', { name: /^12:00/ })
    fireEvent.click(screen.getByRole('button', { name: t('he', 'rsvContinue') }))
    await screen.findByRole('heading', { name: t('he', 'rsvRulesTitle') })

    const link = screen.getByRole('link', { name: 'תנאי ההזמנה' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })
})
