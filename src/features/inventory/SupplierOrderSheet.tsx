import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchItems } from '../menu/api'
import { fetchCurrentLocation } from '../auth/api'
import {
  fetchSupplyItems, fetchSuppliers, fetchPackagings, fetchStockReport,
  type Packaging, type StockKind,
} from './api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'

/** Целевой запас заявки и порог «пора заказывать», в днях расхода */
const TARGET_DAYS = 14
const REFILL_DAYS = 3

interface OrderRow {
  key: string
  kind: StockKind
  id: string
  name: string
  unit: string | null
  stock: number
  /** Средний расход в день за TARGET_DAYS (базовые единицы) */
  perDay: number
  daysLeft: number | null
  suggested: number
}

/** Текст количества для сообщения: граммы → ק"ג, мл → ל׳, фасовки — штуками */
function qtyText(qty: number, unit: string | null, packs: Packaging[]): string {
  const pack = packs.find((p) => qty % p.qty === 0 && qty >= p.qty)
  if (pack) return `${qty / pack.qty} × ${pack.name}`
  if (unit === 'г' && qty >= 1000) return `${Math.round(qty / 10) / 100} ק"ג`
  if (unit === 'мл' && qty >= 1000) return `${Math.round(qty / 10) / 100} ל׳`
  return `${qty}${unit ? ` ${unit}` : ''}`
}

/** Копирование с фолбэком под старый WebView (T2: clipboard API нет) */
function copyText(text: string): boolean {
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text)
      return true
    }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * Заявка поставщику: прогноз по расходу за 14 дней, предзаполненные
 * количества до целевого запаса, текст сообщения — WhatsApp/копия.
 * Текст всегда на иврите: язык общения с поставщиками.
 */
export default function SupplierOrderSheet({ onClose }: { onClose: () => void }) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'

  const { data: items = [] } = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })
  const { data: supplies = [] } = useQuery({ queryKey: ['supply_items'], queryFn: fetchSupplyItems })
  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: fetchSuppliers })
  const { data: packagings = [] } = useQuery({ queryKey: ['supply_packagings'], queryFn: fetchPackagings })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const usage = useQuery({
    queryKey: ['stock_usage'],
    queryFn: () => {
      const to = new Date()
      const from = new Date(to.getTime() - TARGET_DAYS * 24 * 3600 * 1000)
      return fetchStockReport(from, to)
    },
  })

  const [supplierId, setSupplierId] = useState('')
  const [qtyByKey, setQtyByKey] = useState<Record<string, number> | null>(null)

  const packsByItem = useMemo(() => {
    const m: Record<string, Packaging[]> = {}
    for (const p of packagings) (m[p.supply_item_id] ??= []).push(p)
    return m
  }, [packagings])

  const rows = useMemo<OrderRow[]>(() => {
    if (!usage.data) return []
    const perDayByKey = new Map<string, number>()
    for (const r of usage.data) {
      const id = r.supply_item_id ?? r.menu_item_id
      if (!id) continue
      const used = r.sold + r.waste - r.returned
      if (used > 0) perDayByKey.set(`${r.kind}:${id}`, used / TARGET_DAYS)
    }
    const all: OrderRow[] = [
      ...items.filter((i) => i.track_inventory).map((i) => ({
        key: `menu:${i.id}` as const, kind: 'menu' as StockKind, id: i.id,
        name: i.name, unit: null as string | null, stock: i.stock ?? 0,
      })),
      ...supplies.map((s) => ({
        key: `supply:${s.id}` as const, kind: 'supply' as StockKind, id: s.id,
        name: s.name, unit: s.unit, stock: s.stock,
      })),
    ].map((r) => {
      const perDay = perDayByKey.get(r.key) ?? 0
      const daysLeft = perDay > 0 ? Math.max(0, Math.floor(r.stock / perDay)) : null
      let suggested = 0
      if (perDay > 0 && (daysLeft ?? 0) <= REFILL_DAYS) {
        suggested = Math.max(0, Math.ceil(perDay * TARGET_DAYS - r.stock))
        const packs = r.kind === 'supply' ? (packsByItem[r.id] ?? []) : []
        if (packs.length > 0 && suggested > 0) {
          // округляем вверх до целых фасовок (первая — основная)
          suggested = Math.ceil(suggested / packs[0].qty) * packs[0].qty
        }
      }
      return { ...r, perDay, daysLeft, suggested }
    })
    return all
      .filter((r) => r.perDay > 0)
      .sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity))
  }, [usage.data, items, supplies, packsByItem])

  // Предзаполнение один раз после загрузки расхода
  const qty = useMemo<Record<string, number>>(() => {
    if (qtyByKey) return qtyByKey
    const init: Record<string, number> = {}
    for (const r of rows) if (r.suggested > 0) init[r.key] = r.suggested
    return init
  }, [qtyByKey, rows])

  const chosen = rows.filter((r) => (qty[r.key] ?? 0) > 0)

  const orderText = useMemo(() => {
    const lines = chosen.map((r) => {
      const packs = r.kind === 'supply' ? (packsByItem[r.id] ?? []) : []
      return `- ${r.name} — ${qtyText(qty[r.key], r.unit, packs)}`
    })
    return `הזמנה — ${location?.name ?? ''}\n${lines.join('\n')}\nתודה!`
  }, [chosen, qty, packsByItem, location])

  const supplierPhone = suppliers.find((s) => s.id === supplierId)?.phone ?? null

  function openWhatsApp() {
    if (!supplierPhone) return
    const digits = supplierPhone.replace(/\D/g, '')
    const intl = digits.startsWith('0') ? `972${digits.slice(1)}` : digits
    window.open(`https://wa.me/${intl}?text=${encodeURIComponent(orderText)}`, '_blank')
  }

  function setQty(key: string, n: number) {
    setQtyByKey({ ...qty, [key]: n })
  }

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-6 max-h-[92vh] overflow-y-auto animate-[rise-in_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-1">
          <h2 className="flex-1 text-lg font-black text-gray-900">{t(lang, 'supplierOrderTitle')}</h2>
          <button
            onClick={onClose}
            aria-label={t(lang, 'close')}
            className="w-11 h-11 rounded-xl hover:bg-gray-100 active:scale-[0.97] flex items-center justify-center text-xl text-gray-500"
          >
            ✕
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">{t(lang, 'supplierOrderHint')}</p>

        <select
          className="input !py-2.5 mb-3 text-sm"
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
        >
          <option value="">{t(lang, 'supplierNone')}</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}{s.phone ? ` · ${s.phone}` : ''}</option>
          ))}
        </select>

        {rows.length === 0 && !usage.isLoading ? (
          <div className="text-center py-10 text-sm text-gray-500">{t(lang, 'supplierOrderEmpty')}</div>
        ) : (
          <div className="mb-4 max-h-[46vh] overflow-y-auto">
            {rows.map((r) => (
              <div key={r.key} className="flex items-center gap-2 min-h-[48px] border-b border-gray-100">
                <span className="flex-1 min-w-0 truncate text-sm text-gray-900">
                  <bdi>{r.name}</bdi>
                  <span className="text-gray-400 tabular-nums">
                    {' · '}{r.stock}{r.unit ? ` ${r.unit}` : ''}
                  </span>
                  {r.daysLeft != null && (
                    <span className={`ms-2 text-xs tabular-nums ${r.daysLeft <= REFILL_DAYS ? 'text-amber-600 font-semibold' : 'text-gray-400'}`}>
                      ≈{r.daysLeft} {t(lang, 'daysShort')}
                    </span>
                  )}
                </span>
                <input
                  className="input !py-2 !w-24 text-center tabular-nums"
                  inputMode="numeric"
                  value={qty[r.key] || ''}
                  onChange={(e) => setQty(r.key, Math.min(10000000, parseInt(e.target.value.replace(/\D/g, ''), 10) || 0))}
                />
                <span className="w-8 text-xs text-gray-500">{r.unit ?? ''}</span>
              </div>
            ))}
          </div>
        )}

        {chosen.length > 0 && (
          <div dir="rtl" className="bg-gray-50 rounded-xl px-4 py-3 mb-4 text-sm text-gray-900 whitespace-pre-wrap">
            {orderText}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => { if (copyText(orderText)) toast.success(t(lang, 'orderCopied')) }}
            disabled={chosen.length === 0}
            className="btn-secondary flex-1 !py-3 disabled:opacity-40"
          >
            {t(lang, 'orderCopy')}
          </button>
          <button
            onClick={openWhatsApp}
            disabled={chosen.length === 0 || !supplierPhone}
            className="btn-primary flex-1 !py-3 disabled:opacity-40"
          >
            {t(lang, 'orderWhatsApp')}
          </button>
        </div>
      </div>
    </div>
  )
}
