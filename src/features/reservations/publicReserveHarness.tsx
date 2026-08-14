/**
 * Общая обвязка тестов гостевой страницы брони.
 *
 * Страница ходит только в Edge Function, поэтому в тестах подменяется
 * ровно её API-модуль: маршрут, React Query и переходы остаются
 * настоящими. Так тест проверяет тот же порядок экранов, который увидит
 * гость, а не отдельные функции в вакууме.
 */

import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PublicReservePage from './PublicReservePage'
import type { ReservationView, ReserveInfo, ReserveRule } from './publicReserveApi'

export const LOC = '11111111-1111-4111-8111-111111111111'
export const ZONE_INSIDE = '22222222-2222-4222-8222-222222222222'
export const ZONE_TERRACE = '33333333-3333-4333-8333-333333333333'

/** Расписание «Булочки»: вс–чт 08:00–20:00, пт до 15:00, шабат закрыт */
export const WEEKLY = {
  '0': [['08:00', '20:00']], '1': [['08:00', '20:00']], '2': [['08:00', '20:00']],
  '3': [['08:00', '20:00']], '4': [['08:00', '20:00']],
  '5': [['08:00', '15:00']], '6': [],
}

export function makeInfo(overrides: Partial<ReserveInfo['location']> = {}): ReserveInfo {
  return {
    location: {
      id: LOC,
      name: 'Bulochka',
      business_name: 'Bulochka',
      logo_url: 'https://cdn.test/logo.png',
      header_url: 'https://cdn.test/hero.jpg',
      accepting: true,
      published: true,
      instant: true,
      timezone: 'Asia/Jerusalem',
      slot_min: 30,
      max_party: 12,
      address: 'פינסקר 29, תל אביב',
      lat: 32.07,
      lng: 34.77,
      phone: '+972500000000',
      links: {},
      zones: [],
      waitlist: false,
      rules: [],
      schedule: { weekly: WEEKLY, exceptions: {}, lead_min: 30, horizon_days: 30 },
      ...overrides,
    } as ReserveInfo['location'],
  }
}

export function rule(over: Partial<ReserveRule> & { id: string; text: string }): ReserveRule {
  return { level: 'normal', ack: false, url: null, ...over }
}

/**
 * Карточка брони по постоянной ссылке (118). Полная: сервер всегда
 * присылает и контакты точки, и вердикты — обрезанная заглушка роняла бы
 * экран на `location.lat` и выдавала бы это за баг продукта.
 */
export function makeView(over: Partial<ReservationView> = {}): ReservationView {
  return {
    status: 'confirmed',
    reject_reason: null,
    reserved_at: '2027-03-14T10:00:00.000Z',
    party_size: 2,
    customer_name: 'וולד אנוטוב',
    note: null,
    table_label: '7',
    zone_name: 'בפנים',
    zone_id: ZONE_INSIDE,
    created_at: '2027-03-14T08:00:00.000Z',
    duration_min: 90,
    public_token: '55555555-5555-4555-8555-555555555555',
    rescheduled: false,
    can_cancel: true,
    cancel_block: null,
    can_reschedule: true,
    reschedule_block: null,
    location: {
      id: LOC,
      name: 'Bulochka',
      address: 'פינסקר 29, תל אביב',
      phone: '+972500000000',
      lat: 32.07,
      lng: 34.77,
      timezone: 'Asia/Jerusalem',
      policy: null,
    },
    ...over,
  }
}

/** Слоты дня: все свободны, кроме перечисленных в `full` */
export function slots(times: string[], full: string[] = []) {
  return {
    date: '2027-03-14',
    slot_min: 30,
    slots: times.map((time) => ({ time, free: !full.includes(time) })),
  }
}

export function renderReservePage() {
  // Успешная бронь дописывает в адрес постоянную ссылку `?b=<токен>`
  // (118) через history.replaceState. jsdom держит один window на файл,
  // поэтому без сброса СЛЕДУЮЩИЙ тест открывался бы сразу карточкой
  // готовой брони вместо формы.
  window.history.replaceState(null, '', '/')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/reserve/${LOC}`]}>
        <Routes>
          <Route path="/reserve/:locId" element={<PublicReservePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}
