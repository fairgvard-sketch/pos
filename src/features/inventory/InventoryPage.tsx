import { useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import AppSidebar from '../../components/AppSidebar'
import { fetchItems } from '../menu/api'
import { fetchCurrentLocation } from '../auth/api'
import { landingRoute } from '../auth/landing'
import {
  fetchStockMovements, fetchStockReport, fetchSupplyItems, setSupplyItemActive, upsertSupplyItem,
  MOVEMENTS_PAGE, type StockMovement, type MovementType, type SupplyItem,
} from './api'
import ReceiveSheet from './ReceiveSheet'
import StockTakeSheet from './StockTakeSheet'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useNetStore } from '../../lib/offline/net'
import { t, formatTime, type TranslationKey } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import { can } from '../../lib/perms'

type Tab = 'stock' | 'journal' | 'report'
type Preset = 'today' | '7d' | '30d' | 'custom'

const PRESETS: { key: Preset; label: TranslationKey }[] = [
  { key: 'today', label: 'today' },
  { key: '7d', label: 'period7d' },
  { key: '30d', label: 'period30d' },
  { key: 'custom', label: 'periodCustom' },
]

/** Порог «заканчивается»: 1..LOW_STOCK штук — жёлтая подсветка остатка */
const LOW_STOCK = 2

const TAB_HINTS: Record<Tab, TranslationKey> = {
  stock: 'invStockHint',
  journal: 'invJournalHint',
  report: 'invReportHint',
}

const MOV_LABELS: Record<MovementType, TranslationKey> = {
  sale: 'movSale',
  void: 'movVoid',
  split: 'movSplit',
  waste: 'movWaste',
  receive: 'movReceive',
  count: 'movCount',
}

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** YYYY-MM-DD в локальном поясе (toISOString сдвинул бы дату) */
function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Разбор YYYY-MM-DD как локальной полуночи (не UTC) */
function parseDateInput(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * Склад (055): остатки учитываемых товаров, журнал движения
 * (stock_movements) и сводка за период. Приход и инвентаризация —
 * online-only (RPC не идемпотентны), кнопки по правам точки.
 */
export default function InventoryPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  const staff = useAuthStore((s) => s.staff)
  const online = useNetStore((s) => s.online)
  const qc = useQueryClient()

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const { data: items = [] } = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })
  const { data: supplies = [] } = useQuery({ queryKey: ['supply_items'], queryFn: fetchSupplyItems })

  const [tab, setTab] = useState<Tab>('stock')
  const [showReceive, setShowReceive] = useState(false)
  const [showStockTake, setShowStockTake] = useState(false)

  const canReceive = can(staff?.role, 'stock_receive', location?.settings)
  const canTake = can(staff?.role, 'stock_take', location?.settings)

  const tracked = useMemo(() => items.filter((i) => i.track_inventory), [items])
  // Сколько позиций меню живёт без учёта — иначе короткий список читается
  // как «весь склад», хотя это лишь подключённые товары
  const untrackedCount = items.length - tracked.length

  // ── Журнал: страницы по 50, свежие сверху ──────────────────
  const journal = useInfiniteQuery({
    queryKey: ['stock_movements'],
    queryFn: ({ pageParam }) => fetchStockMovements(pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === MOVEMENTS_PAGE ? allPages.length * MOVEMENTS_PAGE : undefined,
  })
  const movements = useMemo(() => {
    const seen = new Set<string>()
    const out: StockMovement[] = []
    for (const page of journal.data?.pages ?? []) {
      for (const m of page) {
        if (!seen.has(m.id)) {
          seen.add(m.id)
          out.push(m)
        }
      }
    }
    return out
  }, [journal.data])

  // ── Сводка: период как в отчётах ───────────────────────────
  const [preset, setPreset] = useState<Preset>('today')
  const [customFrom, setCustomFrom] = useState(() => toDateInput(startOfToday()))
  const [customTo, setCustomTo] = useState(() => toDateInput(startOfToday()))

  const [from, to] = useMemo<[Date, Date]>(() => {
    const t0 = startOfToday()
    switch (preset) {
      case 'today': return [t0, addDays(t0, 1)]
      case '7d': return [addDays(t0, -6), addDays(t0, 1)]
      case '30d': return [addDays(t0, -29), addDays(t0, 1)]
      case 'custom': {
        let f = parseDateInput(customFrom)
        let tt = parseDateInput(customTo)
        if (tt < f) [f, tt] = [tt, f] // перепутанный диапазон — молча чиним
        return [f, addDays(tt, 1)]
      }
    }
  }, [preset, customFrom, customTo])

  const report = useQuery({
    queryKey: ['stock_report', from.toISOString(), to.toISOString()],
    queryFn: () => fetchStockReport(from, to),
    enabled: tab === 'report',
  })

  function openSheet(setter: (v: boolean) => void) {
    if (!online) {
      toast.error(t(lang, 'offlineBlockedHint'))
      return
    }
    setter(true)
  }

  // ── Управление расходниками (переименование/деактивация) ────
  const [editingSupply, setEditingSupply] = useState<SupplyItem | null>(null)
  const renameSupply = useMutation({
    mutationFn: (p: { id: string; name: string; unit: string | null }) =>
      upsertSupplyItem(p.id, p.name, p.unit, null),
    onSuccess: () => {
      setEditingSupply(null)
      qc.invalidateQueries({ queryKey: ['supply_items'] })
    },
    onError: (e) => toast.error(e.message),
  })
  const deactivateSupply = useMutation({
    mutationFn: (id: string) => setSupplyItemActive(id, false),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supply_items'] }),
    onError: (e) => toast.error(e.message),
  })

  /** «12 июл 14:05» — короче formatDate, журнал может тянуться на месяцы */
  function movTime(iso: string): string {
    const d = new Date(iso)
    return `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${formatTime(iso, lang)}`
  }

  // Склад выключен тумблером точки (Настройки → Интерфейс) — уводим на
  // стартовый экран. Ждём загрузку location, чтобы не дёргать редирект зря.
  if (location && location.settings?.interface?.inventory_enabled === false) {
    return <Navigate to={landingRoute(location.service_mode)} replace />
  }

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="inventory" />
      <main className="flex-1 bg-white rounded-3xl overflow-y-auto">
        <div className="max-w-5xl mx-auto p-6">
          <div className="flex items-center gap-3 mb-6">
            <h1 className="text-2xl font-black text-gray-900 flex-1">{t(lang, 'inventory')}</h1>
            {canTake && (
              <button
                onClick={() => openSheet(setShowStockTake)}
                className={`btn-secondary ${online ? '' : '!opacity-40'}`}
              >
                {t(lang, 'stockTakeBtn')}
              </button>
            )}
            {canReceive && (
              <button
                onClick={() => openSheet(setShowReceive)}
                className={`btn-primary ${online ? '' : '!opacity-40'}`}
              >
                {t(lang, 'receiveBtn')}
              </button>
            )}
          </div>

          {/* Табы */}
          <div className="inline-flex bg-gray-100 rounded-xl p-1 mb-3">
            {(['stock', 'journal', 'report'] as Tab[]).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`h-9 px-4 rounded-lg text-sm font-semibold transition-all ${
                  tab === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t(lang, k === 'stock' ? 'invStockTab' : k === 'journal' ? 'invJournalTab' : 'invReportTab')}
              </button>
            ))}
          </div>

          {/* Одна строка «что это» — склад читает и не-товаровед */}
          <p className="text-sm text-gray-500 mb-6 max-w-2xl">{t(lang, TAB_HINTS[tab])}</p>

          {/* ── Остатки ── */}
          {tab === 'stock' && (
            tracked.length === 0 && supplies.length === 0 ? (
              <div className="text-center py-16">
                <div className="text-gray-900 font-bold mb-1">{t(lang, 'invEmpty')}</div>
                <div className="text-sm text-gray-500">{t(lang, 'invEmptyHint')}</div>
              </div>
            ) : (
              <div className="space-y-8">
                {tracked.length > 0 && (
                  <div>
                    <div className="flex items-center gap-3 pb-2 border-b border-gray-200 text-xs font-bold text-gray-400 uppercase tracking-wide">
                      <span className="flex-1">{t(lang, 'items')}</span>
                      <span className="w-24 text-end" title={t(lang, 'invCostColHint')}>{t(lang, 'invCostCol')}</span>
                      <span className="w-16 text-end">{t(lang, 'stockLabel')}</span>
                    </div>
                    {tracked.map((i) => {
                      const stock = i.stock ?? 0
                      return (
                        <div key={i.id} className="flex items-center gap-3 min-h-[48px] border-b border-gray-100">
                          <span className="flex-1 min-w-0 truncate text-sm text-gray-900">
                            <bdi>{i.name}</bdi>
                            {i.sku && <span className="text-gray-400"> · {i.sku}</span>}
                            {!i.is_available && <span className="badge-gray ms-2">{t(lang, 'stopListTitle')}</span>}
                            {i.is_available && stock > 0 && stock <= LOW_STOCK && (
                              <span className="badge-yellow ms-2">{t(lang, 'lowStockBadge')}</span>
                            )}
                          </span>
                          <span className="w-24 text-end text-sm text-gray-500 tabular-nums">
                            {i.cost != null ? formatMoney(i.cost, lang) : <span className="text-gray-300">—</span>}
                          </span>
                          <span
                            className={`w-16 text-end font-bold tabular-nums ${
                              stock <= 0 ? 'text-red-600' : stock <= LOW_STOCK ? 'text-amber-600' : 'text-gray-900'
                            }`}
                          >
                            {stock}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Расходники — не продаются, ведутся только вручную */}
                {supplies.length > 0 && (
                  <div>
                    <div className="flex items-center gap-3 pb-2 border-b border-gray-200 text-xs font-bold text-gray-400 uppercase tracking-wide">
                      <span className="flex-1">{t(lang, 'suppliesTitle')}</span>
                      <span className="w-24 text-end" title={t(lang, 'invCostColHint')}>{t(lang, 'invCostCol')}</span>
                      <span className="w-16 text-end">{t(lang, 'stockLabel')}</span>
                      {canTake && <span className="w-16" />}
                    </div>
                    {supplies.map((s) => (
                      <div key={s.id} className="flex items-center gap-3 min-h-[48px] border-b border-gray-100">
                        {editingSupply?.id === s.id ? (
                          <SupplyEditor
                            item={editingSupply}
                            onChange={setEditingSupply}
                            onSave={() => renameSupply.mutate({ id: s.id, name: editingSupply!.name, unit: editingSupply!.unit })}
                            onCancel={() => setEditingSupply(null)}
                            saving={renameSupply.isPending}
                            saveLabel={t(lang, 'save')}
                            namePh={t(lang, 'supplyNamePh')}
                            unitPh={t(lang, 'supplyUnitPh')}
                          />
                        ) : (
                          <>
                            <span className="flex-1 min-w-0 truncate text-sm text-gray-900">
                              <bdi>{s.name}</bdi>
                              {s.unit && <span className="text-gray-400"> · {s.unit}</span>}
                              {s.stock > 0 && s.stock <= LOW_STOCK && (
                                <span className="badge-yellow ms-2">{t(lang, 'lowStockBadge')}</span>
                              )}
                            </span>
                            <span className="w-24 text-end text-sm text-gray-500 tabular-nums">
                              {s.cost != null ? formatMoney(s.cost, lang) : <span className="text-gray-300">—</span>}
                            </span>
                            <span
                              className={`w-16 text-end font-bold tabular-nums ${
                                s.stock <= 0 ? 'text-red-600' : s.stock <= LOW_STOCK ? 'text-amber-600' : 'text-gray-900'
                              }`}
                            >
                              {s.stock}
                            </span>
                            {canTake && (
                              <div className="w-16 flex items-center justify-end gap-1">
                                <button
                                  onClick={() => setEditingSupply(s)}
                                  aria-label={t(lang, 'edit')}
                                  className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700"
                                >
                                  ✎
                                </button>
                                <button
                                  onClick={() => { if (confirm(t(lang, 'supplyDeactivateConfirm'))) deactivateSupply.mutate(s.id) }}
                                  aria-label={t(lang, 'delete')}
                                  className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-red-600"
                                >
                                  ✕
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {untrackedCount > 0 && (
                  <p className="text-sm text-gray-500 bg-gray-50 rounded-xl px-4 py-3">
                    {t(lang, 'invUntracked').replace('{n}', String(untrackedCount))}
                  </p>
                )}
              </div>
            )
          )}

          {/* ── Журнал ── */}
          {tab === 'journal' && (
            movements.length === 0 && !journal.isLoading ? (
              <div className="text-center py-16 text-sm text-gray-500">{t(lang, 'invJournalEmpty')}</div>
            ) : (
              <div>
                {movements.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 min-h-[48px] border-b border-gray-100 text-sm">
                    <span className="w-28 shrink-0 text-gray-500 tabular-nums text-xs">{movTime(m.created_at)}</span>
                    <span className="w-28 shrink-0 text-gray-500">{t(lang, MOV_LABELS[m.type])}</span>
                    <span className="flex-1 min-w-0 truncate text-gray-900">
                      <bdi>{m.name}</bdi>
                      {m.supply_item_id && <span className="badge-gray ms-2">{t(lang, 'supplyBadge')}</span>}
                      {m.order && <span className="text-gray-400"> · #{m.order.daily_number}</span>}
                      {m.note && <span className="text-gray-400"> · {m.note}</span>}
                    </span>
                    {m.unit_cost != null && m.type === 'receive' && (
                      <span className="shrink-0 text-xs text-gray-400 tabular-nums">{formatMoney(m.unit_cost, lang)}</span>
                    )}
                    <span
                      className={`w-12 shrink-0 text-end font-bold tabular-nums ${
                        m.qty_delta > 0 ? 'text-emerald-600' : 'text-gray-900'
                      }`}
                    >
                      {m.qty_delta > 0 ? `+${m.qty_delta}` : m.qty_delta}
                    </span>
                    <span className="w-14 shrink-0 text-end text-gray-500 tabular-nums">→ {m.stock_after}</span>
                    <span className="w-20 shrink-0 text-end text-xs text-gray-400 truncate">{m.staff?.name ?? ''}</span>
                  </div>
                ))}
                {journal.hasNextPage && (
                  <button
                    onClick={() => journal.fetchNextPage()}
                    disabled={journal.isFetchingNextPage}
                    className="btn-secondary w-full mt-4 disabled:opacity-40"
                  >
                    {t(lang, 'loadMore')}
                  </button>
                )}
              </div>
            )
          )}

          {/* ── Сводка ── */}
          {tab === 'report' && (
            <div>
              <div className="flex flex-wrap items-center gap-3 mb-6">
                <div className="inline-flex bg-gray-100 rounded-xl p-1">
                  {PRESETS.map((p) => (
                    <button
                      key={p.key}
                      onClick={() => setPreset(p.key)}
                      className={`h-9 px-3 rounded-lg text-sm font-semibold transition-all ${
                        preset === p.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {t(lang, p.label)}
                    </button>
                  ))}
                </div>
                {preset === 'custom' && (
                  <div className="flex items-center gap-2">
                    <input type="date" className="input !py-2 !w-40" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                    <span className="text-gray-400">—</span>
                    <input type="date" className="input !py-2 !w-40" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                  </div>
                )}
              </div>

              {(report.data ?? []).length === 0 && !report.isLoading ? (
                <div className="text-center py-16 text-sm text-gray-500">{t(lang, 'invJournalEmpty')}</div>
              ) : (
                <div className="overflow-x-auto">
                  <div className="min-w-[640px]">
                    <div className="flex items-center gap-3 pb-2 border-b border-gray-200 text-xs font-bold text-gray-400 uppercase tracking-wide">
                      <span className="flex-1">{t(lang, 'items')}</span>
                      <span className="w-16 text-end">{t(lang, 'repSold')}</span>
                      <span className="w-16 text-end">{t(lang, 'repReturned')}</span>
                      <span className="w-16 text-end">{t(lang, 'repWaste')}</span>
                      <span className="w-16 text-end">{t(lang, 'repReceived')}</span>
                      <span className="w-16 text-end">{t(lang, 'repCountAdj')}</span>
                      <span className="w-16 text-end">{t(lang, 'repStockNow')}</span>
                    </div>
                    {(report.data ?? []).map((r) => (
                      <div key={r.supply_item_id ?? r.menu_item_id ?? r.name} className="flex items-center gap-3 min-h-[44px] border-b border-gray-100 text-sm">
                        <span className="flex-1 min-w-0 truncate text-gray-900">
                          <bdi>{r.name}</bdi>
                          {r.kind === 'supply' && <span className="badge-gray ms-2">{t(lang, 'supplyBadge')}</span>}
                        </span>
                        <Num value={r.sold} />
                        <Num value={r.returned} />
                        <Num value={r.waste} />
                        <Num value={r.received} accent={r.received > 0} />
                        <Num value={r.count_adj} signed />
                        <span className="w-16 text-end font-bold tabular-nums text-gray-900">{r.stock_now ?? '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {showReceive && <ReceiveSheet onClose={() => setShowReceive(false)} />}
      {showStockTake && <StockTakeSheet onClose={() => setShowStockTake(false)} />}
    </div>
  )
}

/** Инлайн-редактор расходника (имя + единица) в строке остатков */
function SupplyEditor({
  item, onChange, onSave, onCancel, saving, saveLabel, namePh, unitPh,
}: {
  item: SupplyItem
  onChange: (v: SupplyItem) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  saveLabel: string
  namePh: string
  unitPh: string
}) {
  return (
    <div className="flex items-center gap-2 flex-1 py-1">
      <input
        className="input !py-2 flex-1 text-sm"
        placeholder={namePh}
        value={item.name}
        onChange={(e) => onChange({ ...item, name: e.target.value })}
        autoFocus
      />
      <input
        className="input !py-2 !w-20 text-sm"
        placeholder={unitPh}
        value={item.unit ?? ''}
        onChange={(e) => onChange({ ...item, unit: e.target.value })}
      />
      <button
        onClick={onSave}
        disabled={saving || item.name.trim() === ''}
        className="btn-primary !py-2 !px-4 disabled:opacity-40"
      >
        {saveLabel}
      </button>
      <button onClick={onCancel} className="w-9 h-9 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400">✕</button>
    </div>
  )
}

/** Ячейка сводки: ноль приглушён, signed показывает знак дельты */
function Num({ value, signed = false, accent = false }: { value: number; signed?: boolean; accent?: boolean }) {
  return (
    <span
      className={`w-16 text-end tabular-nums ${
        value === 0 ? 'text-gray-300' : accent ? 'font-bold text-emerald-600' : 'text-gray-900'
      }`}
    >
      {signed && value > 0 ? `+${value}` : value}
    </span>
  )
}
