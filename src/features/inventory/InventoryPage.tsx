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
  fetchPackagings, addPackaging, deletePackaging,
  isFractionalUnit, SUPPLY_UNITS,
  MOVEMENTS_PAGE, type StockMovement, type MovementType, type SupplyItem, type StockReportRow,
} from './api'
import { varianceRows, varianceTotals } from './variance'
import ReceiveSheet from './ReceiveSheet'
import StockTakeSheet from './StockTakeSheet'
import SupplyDocsTab from './SupplyDocsTab'
import SupplierOrderSheet from './SupplierOrderSheet'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useNetStore } from '../../lib/offline/net'
import { t, formatTime, type TranslationKey } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import { can } from '../../lib/perms'

type Tab = 'stock' | 'docs' | 'journal' | 'report'
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
  docs: 'invDocsHint',
  journal: 'invJournalHint',
  report: 'invReportHint',
}

const TAB_LABELS: Record<Tab, TranslationKey> = {
  stock: 'invStockTab',
  docs: 'invDocsTab',
  journal: 'invJournalTab',
  report: 'invReportTab',
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
  const [repMode, setRepMode] = useState<'flow' | 'variance'>('flow')
  const [showReceive, setShowReceive] = useState(false)
  const [showStockTake, setShowStockTake] = useState(false)
  const [showOrder, setShowOrder] = useState(false)

  const canReceive = can(staff?.role, 'stock_receive', location?.settings)
  const canTake = can(staff?.role, 'stock_take', location?.settings)

  const tracked = useMemo(() => items.filter((i) => i.track_inventory), [items])

  // Прогноз «кончится через N дней»: расход за 14 дней из оборотки
  const usage = useQuery({
    queryKey: ['stock_usage'],
    queryFn: () => {
      const to = new Date()
      return fetchStockReport(new Date(to.getTime() - 14 * 24 * 3600 * 1000), to)
    },
    enabled: tab === 'stock',
  })
  const daysLeftByKey = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of usage.data ?? []) {
      const id = r.supply_item_id ?? r.menu_item_id
      const used = r.sold + r.waste - r.returned
      if (!id || used <= 0 || r.stock_now == null || r.stock_now <= 0) continue
      m.set(`${r.kind}:${id}`, Math.floor(r.stock_now / (used / 14)))
    }
    return m
  }, [usage.data])
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

  /** Остаток ингредиента: от 1000 базовых единиц показываем кг/л (076) */
  function fmtQty(stock: number, unit: string | null): string {
    if (isFractionalUnit(unit) && Math.abs(stock) >= 1000) {
      return `${Math.round(stock / 10) / 100} ${t(lang, unit === 'мл' ? 'unitL' : 'unitKg')}`
    }
    return String(stock)
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
            {canReceive && (
              <button onClick={() => setShowOrder(true)} className="btn-secondary">
                {t(lang, 'supplierOrderBtn')}
              </button>
            )}
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
            {(['stock', 'docs', 'journal', 'report'] as Tab[]).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`h-9 px-4 rounded-lg text-sm font-semibold transition-all ${
                  tab === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t(lang, TAB_LABELS[k])}
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
                            <DaysLeft d={daysLeftByKey.get(`menu:${i.id}`)} />
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
                      <div key={s.id} className="border-b border-gray-100">
                      <div className="flex items-center gap-3 min-h-[48px]">
                        {editingSupply?.id === s.id ? (
                          <SupplyEditor
                            item={editingSupply}
                            onChange={setEditingSupply}
                            onSave={() => renameSupply.mutate({ id: s.id, name: editingSupply!.name, unit: editingSupply!.unit })}
                            onCancel={() => setEditingSupply(null)}
                            saving={renameSupply.isPending}
                            saveLabel={t(lang, 'save')}
                            namePh={t(lang, 'supplyNamePh')}
                          />
                        ) : (
                          <>
                            <span className="flex-1 min-w-0 truncate text-sm text-gray-900">
                              <bdi>{s.name}</bdi>
                              {s.unit && <span className="text-gray-400"> · {s.unit}</span>}
                              {s.stock > 0 && s.stock <= LOW_STOCK && (
                                <span className="badge-yellow ms-2">{t(lang, 'lowStockBadge')}</span>
                              )}
                              <DaysLeft d={daysLeftByKey.get(`supply:${s.id}`)} />
                            </span>
                            <span className="w-24 text-end text-sm text-gray-500 tabular-nums">
                              {s.cost != null ? formatMoney(s.cost, lang) : <span className="text-gray-300">—</span>}
                            </span>
                            <span
                              className={`w-20 text-end font-bold tabular-nums ${
                                s.stock <= 0 ? 'text-red-600' : s.stock <= LOW_STOCK ? 'text-amber-600' : 'text-gray-900'
                              }`}
                            >
                              {fmtQty(s.stock, s.unit)}
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
                      {/* Фасовки (077): редактируются вместе с расходником */}
                      {editingSupply?.id === s.id && <PackagingsEditor itemId={s.id} />}
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

          {/* ── Поставки (077) ── */}
          {tab === 'docs' && <SupplyDocsTab canManage={canReceive} />}

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
                {/* Режим: оборотка / теория vs факт (P2) */}
                <div className="inline-flex bg-gray-100 rounded-xl p-1 ms-auto">
                  {(['flow', 'variance'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setRepMode(m)}
                      className={`h-9 px-3 rounded-lg text-sm font-semibold transition-all ${
                        repMode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {t(lang, m === 'flow' ? 'repModeFlow' : 'repModeVariance')}
                    </button>
                  ))}
                </div>
              </div>

              {(report.data ?? []).length === 0 && !report.isLoading ? (
                <div className="text-center py-16 text-sm text-gray-500">{t(lang, 'invJournalEmpty')}</div>
              ) : repMode === 'variance' ? (
                <VarianceReport rows={report.data ?? []} />
              ) : (
                <>
                <div className="overflow-x-auto">
                  <div className="min-w-[760px]">
                    <div className="flex items-center gap-3 pb-2 border-b border-gray-200 text-xs font-bold text-gray-400 uppercase tracking-wide">
                      <span className="flex-1">{t(lang, 'items')}</span>
                      <span className="w-14 text-end">{t(lang, 'repOpening')}</span>
                      <span className="w-16 text-end">{t(lang, 'repSold')}</span>
                      <span className="w-16 text-end">{t(lang, 'repReturned')}</span>
                      <span className="w-16 text-end">{t(lang, 'repWaste')}</span>
                      <span className="w-16 text-end">{t(lang, 'repReceived')}</span>
                      <span className="w-16 text-end">{t(lang, 'repCountAdj')}</span>
                      <span className="w-14 text-end">{t(lang, 'repClosing')}</span>
                      <span className="w-20 text-end">{t(lang, 'repValueCol')}</span>
                    </div>
                    {(report.data ?? []).map((r) => (
                      <div key={r.supply_item_id ?? r.menu_item_id ?? r.name} className="flex items-center gap-3 min-h-[44px] border-b border-gray-100 text-sm">
                        <span className="flex-1 min-w-0 truncate text-gray-900">
                          <bdi>{r.name}</bdi>
                          {r.kind === 'supply' && <span className="badge-gray ms-2">{t(lang, 'supplyBadge')}</span>}
                        </span>
                        <span className="w-14 text-end tabular-nums text-gray-500">{r.opening}</span>
                        <Num value={r.sold} />
                        <Num value={r.returned} />
                        <Num value={r.waste} />
                        <Num value={r.received} accent={r.received > 0} />
                        <Num value={r.count_adj} signed />
                        <span className="w-14 text-end font-bold tabular-nums text-gray-900">{r.closing}</span>
                        <span className="w-20 text-end tabular-nums text-gray-500">
                          {r.closing_value != null ? formatMoney(r.closing_value, lang) : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                {/* Итого в деньгах (077/078): приход, расход и стоимость склада */}
                <ReportTotals rows={report.data ?? []} />
                </>
              )}
            </div>
          )}
        </div>
      </main>

      {showReceive && <ReceiveSheet onClose={() => setShowReceive(false)} />}
      {showStockTake && <StockTakeSheet onClose={() => setShowStockTake(false)} />}
      {showOrder && <SupplierOrderSheet onClose={() => setShowOrder(false)} />}
    </div>
  )
}

/** Инлайн-редактор расходника (имя + единица шт/г/мл) в строке остатков */
function SupplyEditor({
  item, onChange, onSave, onCancel, saving, saveLabel, namePh,
}: {
  item: SupplyItem
  onChange: (v: SupplyItem) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  saveLabel: string
  namePh: string
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
      <select
        className="input !py-2 !w-24 text-sm"
        value={item.unit ?? 'шт'}
        onChange={(e) => onChange({ ...item, unit: e.target.value })}
      >
        {/* Легаси-единица свободным текстом остаётся выбираемой */}
        {item.unit && !(SUPPLY_UNITS as readonly string[]).includes(item.unit) && (
          <option value={item.unit}>{item.unit}</option>
        )}
        {SUPPLY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
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

/** «≈N дн.» — прогноз по расходу за 14 дней; ≤3 дней — тревожный цвет */
function DaysLeft({ d }: { d: number | undefined }) {
  const lang = useLangStore((s) => s.lang)
  if (d == null || d > 7) return null
  return (
    <span className={`ms-2 text-xs tabular-nums ${d <= 3 ? 'text-amber-600 font-semibold' : 'text-gray-400'}`}>
      ≈{d} {t(lang, 'daysShort')}
    </span>
  )
}

/**
 * «Теория vs факт» (P2): ожидаемый расход по рецептурам и списаниям против
 * инвентаризационных поправок. Позиции без инвентаризации в периоде честно
 * помечены — они не «идеально сошлись», их просто не проверяли.
 */
function VarianceReport({ rows }: { rows: StockReportRow[] }) {
  const lang = useLangStore((s) => s.lang)
  const vRows = varianceRows(rows)
  const totals = varianceTotals(vRows)

  if (vRows.length === 0) {
    return <div className="text-center py-16 text-sm text-gray-500">{t(lang, 'invJournalEmpty')}</div>
  }

  const pct = (v: number | null) =>
    v === null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v * 1000) / 10}%`

  return (
    <>
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <div className="flex items-center gap-3 pb-2 border-b border-gray-200 text-xs font-bold text-gray-400 uppercase tracking-wide">
            <span className="flex-1">{t(lang, 'items')}</span>
            <span className="w-20 text-end">{t(lang, 'varExpected')}</span>
            <span className="w-20 text-end">{t(lang, 'varFact')}</span>
            <span className="w-20 text-end">{t(lang, 'varDiff')}</span>
            <span className="w-16 text-end">%</span>
            <span className="w-20 text-end">₪</span>
          </div>
          {vRows.map((r) => (
            <div key={r.key} className="flex items-center gap-3 min-h-[44px] border-b border-gray-100 text-sm">
              <span className="flex-1 min-w-0 truncate text-gray-900">
                <bdi>{r.name}</bdi>
                {r.kind === 'supply' && <span className="badge-gray ms-2">{t(lang, 'supplyBadge')}</span>}
                {!r.counted && (
                  <span className="ms-2 text-xs text-gray-400">{t(lang, 'varNotCounted')}</span>
                )}
              </span>
              <span className="w-20 text-end tabular-nums text-gray-500">{r.expected}</span>
              {r.counted ? (
                <>
                  <span className="w-20 text-end tabular-nums text-gray-900">{r.fact}</span>
                  <span className={`w-20 text-end tabular-nums font-semibold ${
                    r.diff > 0 ? 'text-red-600' : r.diff < 0 ? 'text-emerald-600' : 'text-gray-400'
                  }`}>
                    {r.diff > 0 ? `−${r.diff}` : r.diff < 0 ? `+${-r.diff}` : '0'}
                  </span>
                  <span className="w-16 text-end tabular-nums text-gray-500">{pct(r.diffPct === null ? null : -r.diffPct)}</span>
                  <span className={`w-20 text-end tabular-nums font-semibold ${
                    r.diffValue > 0 ? 'text-red-600' : r.diffValue < 0 ? 'text-emerald-600' : 'text-gray-400'
                  }`}>
                    {r.diffValue === 0
                      ? '—'
                      : `${r.diffValue > 0 ? '−' : '+'}${formatMoney(Math.abs(r.diffValue), lang)}`}
                  </span>
                </>
              ) : (
                <>
                  <span className="w-20 text-end text-gray-300">—</span>
                  <span className="w-20 text-end text-gray-300">—</span>
                  <span className="w-16 text-end text-gray-300">—</span>
                  <span className="w-20 text-end text-gray-300">—</span>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-3 mt-4">
        <div className="flex-1 min-w-[140px] bg-red-50 rounded-xl px-4 py-3">
          <div className="text-xs font-bold text-red-400 uppercase tracking-wide mb-1">{t(lang, 'varShortTotal')}</div>
          <div className="font-bold text-red-700 tabular-nums">−{formatMoney(totals.shortageValue, lang)}</div>
        </div>
        <div className="flex-1 min-w-[140px] bg-emerald-50 rounded-xl px-4 py-3">
          <div className="text-xs font-bold text-emerald-500 uppercase tracking-wide mb-1">{t(lang, 'varSurplusTotal')}</div>
          <div className="font-bold text-emerald-700 tabular-nums">+{formatMoney(totals.surplusValue, lang)}</div>
        </div>
        {totals.uncounted > 0 && (
          <div className="flex-1 min-w-[140px] bg-gray-50 rounded-xl px-4 py-3">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">{t(lang, 'varNotCounted')}</div>
            <div className="font-bold text-gray-900 tabular-nums">{totals.uncounted}</div>
          </div>
        )}
      </div>
    </>
  )
}

/** Итоги оборотки в деньгах: приход, нетто-расход, стоимость остатка */
function ReportTotals({ rows }: { rows: StockReportRow[] }) {
  const lang = useLangStore((s) => s.lang)
  const flowIn = rows.reduce((s, r) => s + r.received_value, 0)
  const flowOut = rows.reduce((s, r) => s + r.sold_value + r.waste_value - r.returned_value, 0)
  const stockValue = rows.reduce((s, r) => s + (r.closing_value ?? 0), 0)
  const cell = (label: TranslationKey, v: number) => (
    <div className="flex-1 min-w-[140px] bg-gray-50 rounded-xl px-4 py-3">
      <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">{t(lang, label)}</div>
      <div className="font-bold text-gray-900 tabular-nums">{formatMoney(v, lang)}</div>
    </div>
  )
  return (
    <div className="flex flex-wrap gap-3 mt-4">
      {cell('repFlowIn', flowIn)}
      {cell('repFlowOut', flowOut)}
      {cell('repStockValue', stockValue)}
    </div>
  )
}

/** Фасовки расходника (077): «мешок 25 кг» — кнопки быстрой приёмки */
function PackagingsEditor({ itemId }: { itemId: string }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const { data: packagings = [] } = useQuery({ queryKey: ['supply_packagings'], queryFn: fetchPackagings })
  const mine = packagings.filter((p) => p.supply_item_id === itemId)

  const [name, setName] = useState('')
  const [qty, setQty] = useState('')

  const add = useMutation({
    mutationFn: () => addPackaging(itemId, name.trim(), parseInt(qty, 10)),
    onSuccess: () => {
      setName('')
      setQty('')
      qc.invalidateQueries({ queryKey: ['supply_packagings'] })
    },
    onError: (e) => toast.error(e.message),
  })
  const del = useMutation({
    mutationFn: (id: string) => deletePackaging(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supply_packagings'] }),
    onError: (e) => toast.error(e.message),
  })

  const qtyNum = parseInt(qty, 10)

  return (
    <div className="pb-3 ps-1">
      <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">{t(lang, 'packagingsLabel')}</div>
      <div className="flex flex-wrap items-center gap-2">
        {mine.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1 h-9 ps-3 pe-1 rounded-lg bg-gray-100 text-sm text-gray-700">
            {p.name} · {p.qty}
            <button
              onClick={() => del.mutate(p.id)}
              aria-label={t(lang, 'delete')}
              className="w-7 h-7 rounded-md hover:bg-gray-200 flex items-center justify-center text-gray-400 hover:text-red-600"
            >
              ✕
            </button>
          </span>
        ))}
        <input
          className="input !py-2 !w-36 text-sm"
          placeholder={t(lang, 'packagingNamePh')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input !py-2 !w-32 text-sm"
          inputMode="numeric"
          placeholder={t(lang, 'packagingQtyPh')}
          value={qty}
          onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))}
        />
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending || name.trim() === '' || !(qtyNum >= 1)}
          className="btn-secondary !py-2 !px-4 disabled:opacity-40"
        >
          {t(lang, 'add')}
        </button>
      </div>
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
