import type { RealtimeChannel, Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { useDeviceStore } from '../store/deviceStore'
import { deviceUuid } from './deviceSync'
import { hasSilentPrintPath, printCanvasWithResult } from './escpos'
import type { PrintOutcome } from './printJobs'
import {
  renderKitchenTicketCanvas,
  type KitchenTicketData,
  type KitchenTicketLine,
} from '../features/receipt/printCanvas'
import { notifyPrintFailure } from '../features/receipt/printFailure'

/**
 * Печать тикетов с телефонов официантов (180) на этой кассе.
 *
 * Телефон принтера не имеет: заказ и задание печати сервер пишет одной
 * транзакцией, а касса с настройкой «Печатать заказы официантов»
 * забирает задания (claim_print_jobs — ровно одна касса получает каждое)
 * и отчитывается (finish_print_job). Официант видит итог на телефоне.
 *
 * Будит Realtime (INSERT в print_jobs своей точки), страхует опрос раз в
 * 15 секунд и событие online. Работает и на экране PIN: печать не ждёт
 * кассира. Ошибка принтера — тост с «повторить», как у своих тикетов.
 */

const POLL_MS = 15_000
const CLAIM_BATCH = 10

/**
 * Виды заданий, которые эта сборка умеет печатать (182). Сервер отдаёт
 * только их: старая касса без этого списка получает лишь обычные заказы,
 * иначе распечатала бы отмену как новый заказ и кухня бы его приготовила.
 */
export const PRINT_KINDS = ['kitchen', 'kitchen_void', 'kitchen_move'] as const

export interface WaiterPrintJob {
  id: string
  kind: string
  payload: unknown
  created_at: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function toLine(v: unknown): KitchenTicketLine | null {
  if (!v || typeof v !== 'object') return null
  const l = v as Record<string, unknown>
  const qty = Number.isSafeInteger(l.qty) && (l.qty as number) > 0 ? (l.qty as number) : null
  if (qty === null || !str(l.name)) return null
  return {
    qty,
    name: str(l.name),
    variantName: str(l.variantName) || null,
    modifiers: Array.isArray(l.modifiers) ? l.modifiers.filter((m): m is string => typeof m === 'string') : [],
    notes: str(l.notes),
  }
}

/** Снимок print_jobs.payload → тикет кухни; битый payload не роняет печать */
export function jobTicket(payload: unknown, deviceName: string, kind = 'kitchen'): KitchenTicketData {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const lines = Array.isArray(p.lines) ? p.lines : []
  // Отмена и перенос с телефона (182) — те же плашки «ביטול»/«הועבר», что у кассы
  const edit = kind === 'kitchen_void' ? 'void' : kind === 'kitchen_move' ? 'move' : undefined
  return {
    // Как у дозаказа стола на кассе: без номера, с пометкой стола
    dailyNumber: null,
    orderType: 'here',
    customerName: '',
    tableLabel: str(p.tableLabel),
    staffName: str(p.staffName),
    deviceName,
    lines: lines.map(toLine).filter((l): l is KitchenTicketLine => l !== null),
    fire: p.fire === true,
    ...(edit ? { kind: edit } : {}),
    ...(edit === 'move' ? { movedTo: str(p.movedTo) } : {}),
  }
}

/** Код ошибки для finish_print_job: статус принтера + деталь моста */
export function failureCode(o: PrintOutcome): string {
  return [o.status, o.message].filter(Boolean).join(': ')
}

export interface RelayDeps {
  claim: () => Promise<WaiterPrintJob[]>
  finish: (id: string, ok: boolean, error: string | null) => Promise<void>
  print: (ticket: KitchenTicketData) => Promise<PrintOutcome>
  canPrint: () => boolean
  deviceName: () => string
  notifyFailure: (outcome: PrintOutcome, retry: () => void) => void
}

/** Ядро без браузерных подписок — тестируется с подменёнными зависимостями */
export function createRelay(deps: RelayDeps) {
  let busy = false
  let again = false
  // Итог печати, который не дошёл до сервера (сеть): отправим при следующем
  // проходе, иначе через 2 минуты задание станет «прервано» при напечатанном тикете
  const unsent = new Map<string, { ok: boolean; error: string | null }>()

  async function report(id: string, ok: boolean, error: string | null) {
    try {
      await deps.finish(id, ok, error)
      unsent.delete(id)
    } catch {
      unsent.set(id, { ok, error })
    }
  }

  async function printTicket(id: string, ticket: KitchenTicketData) {
    let outcome: PrintOutcome
    if (!deps.canPrint()) {
      outcome = { ok: false, status: 'disconnected', message: 'no-print-path' }
    } else {
      try {
        outcome = await deps.print(ticket)
      } catch (e) {
        outcome = { ok: false, status: 'error', message: e instanceof Error ? e.message : null }
      }
    }
    await report(id, outcome.ok, outcome.ok ? null : failureCode(outcome))
    if (!outcome.ok) deps.notifyFailure(outcome, () => void printTicket(id, ticket))
  }

  async function drain(): Promise<void> {
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      do {
        again = false
        for (const [id, r] of [...unsent]) await report(id, r.ok, r.error)
        const jobs = await deps.claim()
        for (const job of jobs) await printTicket(job.id, jobTicket(job.payload, deps.deviceName(), job.kind))
        // Полная пачка — за ней может ждать ещё
        if (jobs.length >= CLAIM_BATCH) again = true
      } while (again)
    } catch {
      // Сеть или сервер: следующий опрос/событие повторит
    } finally {
      busy = false
    }
  }

  return { drain }
}

const relay = createRelay({
  claim: async () => {
    const { data, error } = await supabase.rpc('claim_print_jobs', { p_device_uuid: deviceUuid(), p_kinds: [...PRINT_KINDS] })
    if (error) throw new Error(error.message)
    return (data ?? []) as WaiterPrintJob[]
  },
  finish: async (id, ok, error) => {
    const { error: e } = await supabase.rpc('finish_print_job', { p_job_id: id, p_ok: ok, p_error: error })
    if (e) throw new Error(e.message)
  },
  print: (ticket) =>
    printCanvasWithResult(renderKitchenTicketCanvas(ticket), useDeviceStore.getState().printMode === 'rawbt'),
  canPrint: () => hasSilentPrintPath(useDeviceStore.getState().printMode === 'rawbt'),
  deviceName: () => useDeviceStore.getState().deviceName,
  notifyFailure: (outcome, retry) => notifyPrintFailure(outcome.status, retry, outcome.message),
})

let inited = false
let channel: RealtimeChannel | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let activeLoc: string | null = null
let sessionLoc: string | null = null
let channelSeq = 0

const onOnline = () => void relay.drain()

function locationOf(session: Session | null): string | null {
  const loc = session?.user?.app_metadata?.location_id
  return typeof loc === 'string' && loc ? loc : null
}

function stop() {
  if (channel) void supabase.removeChannel(channel)
  channel = null
  if (pollTimer !== null) clearInterval(pollTimer)
  pollTimer = null
  window.removeEventListener('online', onOnline)
  activeLoc = null
}

function start(loc: string) {
  activeLoc = loc
  channel = supabase
    .channel(`waiter-print-${++channelSeq}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'print_jobs', filter: `location_id=eq.${loc}` },
      () => void relay.drain())
    .subscribe()
  pollTimer = setInterval(() => void relay.drain(), POLL_MS)
  window.addEventListener('online', onOnline)
  void relay.drain()
}

function apply() {
  const want = useDeviceStore.getState().printWaiterTickets ? sessionLoc : null
  if (want === activeLoc) return
  stop()
  if (want) start(want)
}

/** Подключить печать заказов официантов. Зовётся один раз из App. */
export function initWaiterPrintRelay(): void {
  if (inited) return
  inited = true
  void supabase.auth.getSession().then(({ data }) => {
    sessionLoc = locationOf(data.session)
    apply()
  })
  supabase.auth.onAuthStateChange((_event, session) => {
    sessionLoc = locationOf(session)
    apply()
  })
  useDeviceStore.subscribe(apply)
}
