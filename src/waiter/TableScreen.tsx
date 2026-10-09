import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../store/langStore'
import { t, type Lang, type TranslationKey } from '../lib/i18n'
import { formatMoney } from '../lib/money'
import Icon from '../components/Icon'
import ItemPicker from '../features/sell/ItemPicker'
import BillLineSheet, { type BillLineSheetMode } from '../features/sell/BillLineSheet'
import { fireTargets, heldLineKeys, nextCourse } from '../features/sell/courses'
import { defaultConfig, linkedGroups, needsPicker } from '../features/sell/itemConfig'
import type { CartLine } from '../store/cartStore'
import {
  classify, fetchBill, fetchHall, fetchMenu, fireItems, moveLines, sendOrder, voidLine,
  type WaiterBill, type WaiterBillLine, type WaiterErrorKind, type WaiterMenuItem,
} from './api'
import { EMPTY_DRAFT, linesCount, unitPrice, type DraftLine, type NewLine } from './draft'
import { useWaiterDrafts, useWaiterSession } from './store'
import { ticketState, useTicketTracking } from './tickets'
import MenuSheet from './MenuSheet'

const ERROR_TEXT: Record<WaiterErrorKind, TranslationKey> = {
  network: 'wNotSent',
  revoked: 'wRevoked',
  session: 'wErrSession',
  locked: 'pinLockedOut',
  unavailable: 'wErrUnavailable',
  shift: 'wShiftClosed',
  table: 'wErrTable',
  invalid_code: 'wErrGeneric',
  unknown: 'wErrGeneric',
}

function errorText(lang: Lang, e: unknown): string {
  return t(lang, ERROR_TEXT[classify(e)])
}

/** Сеть браузера: без неё убрать и перенести нельзя — PIN менеджера проверяет сервер */
function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

function courseLabel(lang: Lang, course: number | null): string {
  return course ? t(lang, 'courseChip').replace('{n}', String(course)) : t(lang, 'courseChipNone')
}

export default function TableScreen() {
  const { tableId = '' } = useParams<{ tableId: string }>()
  const lang = useLangStore((s) => s.lang)
  const session = useWaiterSession((s) => s.session)!
  const navigate = useNavigate()
  const qc = useQueryClient()
  const now = useTicketTracking()
  const online = useBrowserOnline()

  const draft = useWaiterDrafts((s) => s.tables[tableId]) ?? EMPTY_DRAFT
  const tableJobs = useWaiterDrafts((s) => s.jobs).filter((j) => j.tableId === tableId)
  const lastJob = tableJobs[tableJobs.length - 1]
  const drafts = useWaiterDrafts.getState

  const hallQ = useQuery({ queryKey: ['w_hall'], queryFn: () => fetchHall(session.token), refetchInterval: 5000 })
  const billQ = useQuery({
    queryKey: ['w_bill', tableId],
    queryFn: () => fetchBill(session.token, tableId),
    refetchInterval: 10_000,
  })
  const menuQ = useQuery({ queryKey: ['w_menu'], queryFn: () => fetchMenu(session.token), staleTime: 5 * 60_000 })

  const table = hallQ.data?.tables.find((tb) => tb.id === tableId)
  const bill = billQ.data
  const lines = useMemo(() => bill?.lines ?? [], [bill])
  const menu = menuQ.data
  const groups = menu?.modifier_groups ?? []

  const [menuOpen, setMenuOpen] = useState(false)
  const [picker, setPicker] = useState<{ item: WaiterMenuItem; line: DraftLine | null } | null>(null)
  // Fire: выбор блюд открывается только значком огня (решение владельца
  // 10.10.2026) — без постоянных квадратиков и кнопок на каждой строке
  const [picking, setPicking] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // Окно отправленной позиции (182). opUuid — на всё окно: повтор после
  // таймаута не уберёт и не перенесёт дважды
  const [lineSheet, setLineSheet] = useState<{ line: WaiterBillLine; mode: BillLineSheetMode; opUuid: string } | null>(null)
  const openLine = (line: WaiterBillLine, mode: BillLineSheetMode = 'menu') =>
    setLineSheet({ line, mode, opUuid: crypto.randomUUID() })

  // Какие новые блюда кухня получит не сразу, а по Fire (то же правило, что сервер)
  const heldPreview = heldLineKeys(lines, draft.lines)
  const heldLines = lines.filter((l) => l.held)
  const servedLines = lines.filter((l) => !l.held)
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of draft.lines) m.set(l.itemId, (m.get(l.itemId) ?? 0) + l.qty)
    return m
  }, [draft.lines])

  /** «−» в меню: последняя добавленная строка этого блюда теряет порцию */
  function removeOne(item: WaiterMenuItem) {
    const last = [...draft.lines].reverse().find((l) => l.itemId === item.id)
    if (last) drafts().setQty(tableId, last.key, last.qty - 1)
  }

  function addItem(item: WaiterMenuItem) {
    const g = linkedGroups(item, groups)
    if (needsPicker(item, g)) {
      setPicker({ item, line: null })
      return
    }
    const { priceOverride: _p, ...cfg } = defaultConfig(item, g)
    drafts().add(tableId, { ...cfg, course: cfg.course ?? null } as NewLine)
  }

  const send = useMutation({
    mutationFn: async () => {
      // Замороженное уходит тем же op_uuid при каждом повторе (см. draft.ts)
      const pending = drafts().freeze(tableId)
      if (!pending) return null
      return sendOrder(session.token, tableId, pending)
    },
    onSuccess: (res) => {
      if (!res) return
      drafts().sent(tableId)
      if (res.job_id) {
        drafts().track({ id: res.job_id, tableId, tableLabel: table?.label ?? '', createdAt: new Date().toISOString() })
      }
      toast.success(t(lang, 'fireSent'))
      void qc.invalidateQueries({ queryKey: ['w_bill', tableId] })
      void qc.invalidateQueries({ queryKey: ['w_hall'] })
    },
    onError: (e) => {
      // Ответа нет — исход неизвестен: замороженное ждёт «Повторить».
      // Явный отказ сервера — ничего не записано, блюда снова в черновике.
      if (classify(e) !== 'network') drafts().rejected(tableId)
      toast.error(errorText(lang, e))
    },
  })

  const fire = useMutation({
    mutationFn: (targets: WaiterBillLine[]) =>
      fireItems(session.token, bill!.order!.id, targets.map((l) => l.id), crypto.randomUUID()),
    onMutate: async (targets) => {
      const key = ['w_bill', tableId]
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<WaiterBill>(key)
      const ids = new Set(targets.map((l) => l.id))
      qc.setQueryData<WaiterBill>(key, (b) => b && { ...b, lines: b.lines.map((l) => (ids.has(l.id) ? { ...l, held: false } : l)) })
      setSelected(new Set())
      setPicking(false)
      return { prev }
    },
    onSuccess: (res) => {
      if (res.job_id) {
        drafts().track({ id: res.job_id, tableId, tableLabel: table?.label ?? '', createdAt: new Date().toISOString() })
      }
      toast.success(t(lang, 'fireSent'))
    },
    onError: (e, _targets, ctx) => {
      // Fire не копится без сети: откатываем и даём нажать ещё раз —
      // если первый всё же дошёл, сервер вернёт пустой fired (no-op)
      if (ctx?.prev) qc.setQueryData(['w_bill', tableId], ctx.prev)
      toast.error(errorText(lang, e))
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['w_bill', tableId] })
      void qc.invalidateQueries({ queryKey: ['w_hall'] })
    },
  })

  function trackJob(jobId: string | null) {
    if (!jobId) return
    drafts().track({ id: jobId, tableId, tableLabel: table?.label ?? '', createdAt: new Date().toISOString() })
  }

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['w_bill'] })
    void qc.invalidateQueries({ queryKey: ['w_hall'] })
  }

  /** Убрать отправленное по PIN менеджера; кухне — тикет «ביטול» с кассы */
  const voidMut = useMutation({
    mutationFn: (v: { line: WaiterBillLine; qty: number | null; reason: string; pin: string; opUuid: string }) =>
      voidLine(session.token, v.line.id, v.qty, v.reason, v.pin, v.opUuid),
    onSuccess: (res) => {
      if (!res.ok) return
      trackJob(res.job_id)
      toast.success(t(lang, 'lineRemoved'))
      refresh()
    },
    onError: (e) => toast.error(errorText(lang, e)),
  })

  /** Перенести на другой стол; опустевший стол — назад в зал */
  const moveMut = useMutation({
    mutationFn: (v: { line: WaiterBillLine; toTableId: string; opUuid: string }) =>
      moveLines(session.token, [v.line.id], v.toTableId, v.opUuid),
    onSuccess: (res) => {
      trackJob(res.job_id)
      toast.success(t(lang, 'lineMoved').replace('{n}', res.to_label))
      setLineSheet(null)
      refresh()
      if (res.source_empty) navigate('/waiter')
    },
    onError: (e) => toast.error(errorText(lang, e)),
  })

  /** «Ещё одну такую же» — в «Новое», уходит кнопкой «Отправить» */
  function addOneMore(l: WaiterBillLine) {
    const item = menu?.items.find((i) => i.id === l.menu_item_id)
    if (!item) return
    const mods = (l.mods ?? []).filter((m): m is { id: string; name: string; priceDelta: number } => !!m.id)
    drafts().add(tableId, {
      itemId: item.id,
      name: l.name,
      variantId: l.variant_id ?? null,
      variantName: l.variant_name,
      basePrice: (l.unit_price ?? 0) - mods.reduce((s, m) => s + m.priceDelta, 0),
      mods,
      notes: l.notes ?? '',
      course: l.course,
    })
    toast.success(t(lang, 'lineAddedToDraft'))
  }

  /** «+» только для блюда из каталога, которое сейчас можно заказать */
  function canAddOne(l: WaiterBillLine): boolean {
    const item = l.menu_item_id ? menu?.items.find((i) => i.id === l.menu_item_id) : undefined
    return !!item && item.is_available
  }

  function toggleHeld(id: string) {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** Значок огня: режим выбора, ближайший курс уже отмечен — обычно остаётся подтвердить */
  function startPicking() {
    setSelected(new Set(fireTargets(lines, new Set()).map((l) => l.id)))
    setPicking(true)
  }

  // Придержанное кончилось (Fire с кассы, перенос) — выбирать нечего
  const firing = picking && heldLines.length > 0
  const fireIds = heldLines.filter((l) => selected.has(l.id))
  const newCount = linesCount(draft.lines)
  const pending = draft.pending
  const shiftClosed = hallQ.data ? !hallQ.data.shift_open : false
  const job = lastJob ? ticketState(lastJob, lang, now) : null

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <header
        className="sticky top-0 z-10 bg-[#f8f9fb] border-b border-gray-100 px-4 pb-3 flex items-center gap-3"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <button className="btn-secondary shrink-0 !px-3" onClick={() => navigate('/waiter')} aria-label={t(lang, 'back')}>
          <span aria-hidden className="text-lg">{lang === 'he' ? '→' : '←'}</span>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-xl font-bold text-gray-900 truncate">
            {t(lang, 'tableLabel')} {table?.label ?? ''}
          </div>
          {bill?.order && (
            <div className="text-sm text-gray-500 tabular-nums">{formatMoney(bill.order.total, lang)}</div>
          )}
        </div>
      </header>

      <main className="flex-1 px-4 pt-4 space-y-6" style={{ paddingBottom: 'calc(10rem + env(safe-area-inset-bottom))' }}>
        {shiftClosed && (
          <p className="card px-4 py-3 text-sm font-medium text-gray-900" role="status">{t(lang, 'wShiftClosed')}</p>
        )}

        {pending && (
          <section className="card !bg-white !border-2 !border-red-500 p-4 space-y-3" role="alert">
            <div>
              <div className="font-bold text-red-600">{t(lang, 'wNotSent')}</div>
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'wNotSentHint')}</p>
            </div>
            <ul className="text-sm text-gray-900 space-y-1">
              {pending.lines.map((l) => (
                <li key={l.lineId} className="flex gap-2">
                  <span className="tabular-nums font-semibold">{l.qty}×</span>
                  <span className="flex-1 min-w-0 truncate">{l.name}{l.variantName ? ` · ${l.variantName}` : ''}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {draft.lines.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-500">{t(lang, 'wNew')}</h2>
            {draft.lines.map((l) => {
              const item = menu?.items.find((i) => i.id === l.itemId)
              return (
                <div key={l.key} className="card p-3">
                  <button
                    className="w-full flex items-start gap-3 text-start"
                    onClick={() => item && setPicker({ item, line: l })}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-gray-900">
                        {l.name}{l.variantName ? ` · ${l.variantName}` : ''}
                      </div>
                      {(l.mods.length > 0 || l.notes) && (
                        <div className="text-sm text-gray-500">
                          {[...l.mods.map((m) => m.name), l.notes].filter(Boolean).join(' · ')}
                        </div>
                      )}
                      {heldPreview.has(l.key) && <span className="badge-gray mt-1">{t(lang, 'heldTitle')}</span>}
                    </div>
                    <span className="font-semibold text-gray-900 tabular-nums">{formatMoney(unitPrice(l) * l.qty, lang)}</span>
                  </button>
                  <div className="flex items-center justify-between gap-3 mt-3">
                    <button
                      className="h-11 px-4 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700 active:scale-[0.97]"
                      onClick={() => drafts().patch(tableId, l.key, { course: nextCourse(l.course) })}
                      aria-label={t(lang, 'courseChipHint')}
                    >
                      {courseLabel(lang, l.course)}
                    </button>
                    <div className="flex items-center gap-1" dir="ltr">
                      <button
                        className="w-11 h-11 rounded-xl border border-gray-200 bg-white text-xl font-bold text-gray-900 active:scale-[0.95]"
                        onClick={() => drafts().setQty(tableId, l.key, l.qty - 1)}
                        aria-label="-"
                      >
                        −
                      </button>
                      <span className="w-10 text-center text-lg font-bold text-gray-900 tabular-nums">{l.qty}</span>
                      <button
                        className="w-11 h-11 rounded-xl border border-gray-200 bg-white text-xl font-bold text-gray-900 active:scale-[0.95]"
                        onClick={() => drafts().setQty(tableId, l.key, l.qty + 1)}
                        aria-label="+"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </section>
        )}

        {heldLines.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3 min-h-11">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-gray-500">{t(lang, 'heldTitle')}</h2>
                {firing && <p className="text-sm font-semibold text-gray-900">{t(lang, 'wFirePick')}</p>}
              </div>
              {!firing && (
                <button
                  onClick={startPicking}
                  disabled={fire.isPending}
                  aria-label={t(lang, 'fireItem')}
                  className="shrink-0 w-11 h-11 rounded-xl bg-gray-900 text-white flex items-center justify-center active:scale-[0.95] disabled:opacity-40"
                >
                  <Icon name="fire" size={20} />
                </button>
              )}
            </div>
            {heldLines.map((l) => {
              const on = selected.has(l.id)
              return firing ? (
                // Режим Fire: тап по строке отмечает блюдо
                <button
                  key={l.id}
                  onClick={() => toggleHeld(l.id)}
                  aria-pressed={on}
                  aria-label={`${t(lang, 'fireMark')}: ${l.name}`}
                  className={`card w-full p-3 min-h-11 flex items-start gap-3 text-start ${on ? '!border-gray-900' : ''}`}
                >
                  <span
                    className={`mt-0.5 w-5 h-5 rounded-md border-2 shrink-0 ${on ? 'bg-gray-900 border-gray-900' : 'border-gray-300'}`}
                    aria-hidden
                  />
                  <BillLineText lang={lang} line={l} />
                </button>
              ) : (
                // Обычно — окно позиции: количество, перенос, убрать
                <button
                  key={l.id}
                  onClick={() => openLine(l)}
                  aria-label={`${t(lang, 'lineActions')}: ${l.name}`}
                  className="card w-full p-3 min-h-11 flex items-start gap-3 text-start"
                >
                  <BillLineText lang={lang} line={l} />
                </button>
              )
            })}
          </section>
        )}

        {servedLines.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-500">{t(lang, 'wOnTable')}</h2>
            <div className="card divide-y divide-gray-100">
              {servedLines.map((l) => (
                <button
                  key={l.id}
                  onClick={() => openLine(l)}
                  aria-label={`${t(lang, 'lineActions')}: ${l.name}`}
                  className="w-full p-3 min-h-11 flex items-start gap-3 text-start active:bg-gray-50"
                >
                  <BillLineText lang={lang} line={l} />
                </button>
              ))}
            </div>
          </section>
        )}

        {billQ.isSuccess && lines.length === 0 && draft.lines.length === 0 && !pending && (
          <p className="text-center text-gray-500 py-8">{t(lang, 'wEmptyTable')}</p>
        )}
      </main>

      <footer
        className="fixed bottom-0 inset-x-0 z-20 bg-white border-t border-gray-100 px-4 pt-3 space-y-2"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        {job && (
          <p
            className={`text-sm text-center ${job.tone === 'bad' ? 'text-gray-900 font-semibold' : 'text-gray-500'}`}
            role={job.tone === 'bad' ? 'alert' : 'status'}
          >
            {job.text}
          </p>
        )}
        {firing ? (
          <div className="flex gap-3">
            <button className="btn-secondary !h-14 !text-base" onClick={() => setPicking(false)}>
              {t(lang, 'cancel')}
            </button>
            <button
              className="btn-primary flex-1 !h-14 !text-lg gap-2"
              disabled={fire.isPending || fireIds.length === 0}
              onClick={() => fire.mutate(fireIds)}
              aria-label={`${t(lang, 'fireItem')} · ${fireIds.length}`}
            >
              <Icon name="fire" size={22} />
              <span className="tabular-nums">{fireIds.length}</span>
            </button>
          </div>
        ) : (
        <div className="flex gap-3">
          <button className="btn-secondary !h-14 !text-base" onClick={() => setMenuOpen(true)} disabled={!menu}>
            {t(lang, 'menu')}
          </button>
          <button
            className="btn-primary flex-1 !h-14 !text-base"
            disabled={send.isPending || (!pending && newCount === 0)}
            onClick={() => send.mutate()}
          >
            {send.isPending
              ? t(lang, 'wSending')
              : pending
                ? t(lang, 'wRetry')
                : `${t(lang, 'wSend')}${newCount > 0 ? ` · ${newCount}` : ''}`}
          </button>
        </div>
        )}
      </footer>

      {menuOpen && menu && (
        <MenuSheet menu={menu} counts={counts} total={newCount} onPick={addItem} onDecrement={removeOne} onClose={() => setMenuOpen(false)} />
      )}

      {lineSheet && (() => {
        const l = lineSheet.line
        const occupancy = new Map((hallQ.data?.open ?? []).map((o) => [o.table_id, o]))
        return (
          <BillLineSheet
            line={l}
            lang={lang}
            isRtl={lang === 'he'}
            initialMode={lineSheet.mode}
            initialVoidQty={null}
            tables={hallQ.data?.tables ?? []}
            occupancy={occupancy}
            currentTableId={tableId}
            online={online}
            synced
            busy={voidMut.isPending || moveMut.isPending || fire.isPending}
            onAddOne={canAddOne(l) ? () => { addOneMore(l); setLineSheet(null) } : undefined}
            onVoid={async (qty, reason, pin) => {
              try {
                const res = await voidMut.mutateAsync({ line: l, qty, reason, pin, opUuid: lineSheet.opUuid })
                if (!res.ok) return 'bad_pin'
                setLineSheet(null)
                return 'ok'
              } catch {
                return 'error'
              }
            }}
            onMove={(toTableId) => moveMut.mutate({ line: l, toTableId, opUuid: lineSheet.opUuid })}
            onClose={() => setLineSheet(null)}
          />
        )
      })()}

      {picker && (
        <ItemPicker
          item={picker.item}
          groups={linkedGroups(picker.item, groups)}
          line={picker.line ? ({ ...picker.line, priceOverride: null } as CartLine) : null}
          onConfirm={(cfg) => {
            if (picker.line) {
              drafts().patch(tableId, picker.line.key, cfg)
            } else {
              drafts().add(tableId, {
                itemId: picker.item.id,
                name: picker.item.name,
                ...cfg,
                course: picker.item.course ?? null,
              })
            }
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}

function BillLineText({ lang, line }: { lang: Lang; line: WaiterBillLine }) {
  return (
    <>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-gray-900">
          <span className="tabular-nums">{line.qty}×</span> {line.name}
          {line.variant_name ? ` · ${line.variant_name}` : ''}
        </div>
        {(line.modifiers.length > 0 || line.notes) && (
          <div className="text-sm text-gray-500">{[...line.modifiers, line.notes].filter(Boolean).join(' · ')}</div>
        )}
        {line.course && <div className="text-xs text-gray-500 mt-0.5">{courseLabel(lang, line.course)}</div>}
      </div>
      <span className="text-sm font-semibold text-gray-900 tabular-nums">{formatMoney(line.line_total, lang)}</span>
    </>
  )
}
