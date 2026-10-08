import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { PrintJobStatus, WaiterLocation, WaiterStaff } from './api'
import {
  EMPTY_DRAFT, addLine, freeze, patchLine, setQty, unfreeze,
  type NewLine, type PendingSend, type TableDraft,
} from './draft'

/**
 * Состояние телефона официанта (180).
 *
 * PIN-сессия — sessionStorage, как у кассы: закрыл приложение — снова PIN.
 * Черновики и неотправленное — localStorage: заказ, не дошедший до кухни,
 * переживает закрытие приложения и ждёт «Повторить».
 */

export interface WaiterSession {
  token: string
  staff: WaiterStaff
  location: WaiterLocation
}

interface SessionState {
  session: WaiterSession | null
  /** Телефон отключили — экран допуска показывает причину */
  revoked: boolean
  setSession: (s: WaiterSession | null) => void
  setRevoked: (v: boolean) => void
}

export const useWaiterSession = create<SessionState>()(
  persist(
    (set) => ({
      session: null,
      revoked: false,
      setSession: (session) => set({ session }),
      setRevoked: (revoked) => set({ revoked }),
    }),
    {
      name: 'kassa-waiter-session',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ session: s.session }),
    }
  )
)

export interface TrackedJob {
  id: string
  tableId: string
  tableLabel: string
  createdAt: string
  status: PrintJobStatus
}

/** Тикеты старше часа не отслеживаем: кухня давно знает итог */
const JOB_TTL_MS = 60 * 60_000
const MAX_JOBS = 30

interface DraftState {
  tables: Record<string, TableDraft>
  jobs: TrackedJob[]
  add: (tableId: string, line: NewLine) => void
  setQty: (tableId: string, key: string, qty: number) => void
  patch: (tableId: string, key: string, patch: Partial<NewLine>) => void
  /** Заморозить черновик к отправке (или вернуть уже замороженное — для повтора) */
  freeze: (tableId: string) => PendingSend | null
  /** Сервер принял: замороженное ушло */
  sent: (tableId: string) => void
  /** Сервер явно отказал: замороженное снова в черновике */
  rejected: (tableId: string) => void
  track: (job: Omit<TrackedJob, 'status'>) => void
  updateJobs: (rows: { id: string; status: PrintJobStatus }[]) => void
  /** Официант сказал кухне голосом — убрать предупреждение */
  dismissJob: (id: string) => void
  clearAll: () => void
}

function draftOf(s: DraftState, tableId: string): TableDraft {
  return s.tables[tableId] ?? EMPTY_DRAFT
}

function prune(jobs: TrackedJob[], now = Date.now()): TrackedJob[] {
  return jobs.filter((j) => now - new Date(j.createdAt).getTime() < JOB_TTL_MS).slice(-MAX_JOBS)
}

export const useWaiterDrafts = create<DraftState>()(
  persist(
    (set, get) => ({
      tables: {},
      jobs: [],
      add: (tableId, line) =>
        set((s) => {
          const d = draftOf(s, tableId)
          return { tables: { ...s.tables, [tableId]: { ...d, lines: addLine(d.lines, line, crypto.randomUUID()) } } }
        }),
      setQty: (tableId, key, qty) =>
        set((s) => {
          const d = draftOf(s, tableId)
          return { tables: { ...s.tables, [tableId]: { ...d, lines: setQty(d.lines, key, qty) } } }
        }),
      patch: (tableId, key, p) =>
        set((s) => {
          const d = draftOf(s, tableId)
          return { tables: { ...s.tables, [tableId]: { ...d, lines: patchLine(d.lines, key, p) } } }
        }),
      freeze: (tableId) => {
        const d = draftOf(get(), tableId)
        if (d.pending) return d.pending
        if (d.lines.length === 0) return null
        const pending = freeze(d.lines, () => crypto.randomUUID())
        set((s) => ({ tables: { ...s.tables, [tableId]: { lines: [], pending } } }))
        return pending
      },
      sent: (tableId) =>
        set((s) => {
          const d = draftOf(s, tableId)
          return { tables: { ...s.tables, [tableId]: { ...d, pending: null } } }
        }),
      rejected: (tableId) =>
        set((s) => ({ tables: { ...s.tables, [tableId]: unfreeze(draftOf(s, tableId)) } })),
      track: (job) =>
        set((s) => ({ jobs: prune([...s.jobs.filter((j) => j.id !== job.id), { ...job, status: 'pending' }]) })),
      updateJobs: (rows) =>
        set((s) => {
          const byId = new Map(rows.map((r) => [r.id, r.status]))
          return { jobs: prune(s.jobs.map((j) => (byId.has(j.id) ? { ...j, status: byId.get(j.id)! } : j))) }
        }),
      dismissJob: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
      clearAll: () => set({ tables: {}, jobs: [] }),
    }),
    { name: 'kassa-waiter-drafts' }
  )
)

/** Итог тикета ещё не известен — его стоит опрашивать */
export function jobOpen(j: TrackedJob): boolean {
  return j.status === 'pending' || j.status === 'printing'
}

/** Касса не взяла тикет за 45 секунд — кухне надо сказать голосом */
export function jobStuck(j: TrackedJob, now = Date.now()): boolean {
  return j.status === 'pending' && now - new Date(j.createdAt).getTime() > 45_000
}
