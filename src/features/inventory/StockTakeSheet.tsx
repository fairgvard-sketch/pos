import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchItems } from '../menu/api'
import { fetchSupplyItems, stockTake, type CountItem, type StockKind } from './api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'

interface Row {
  key: string
  kind: StockKind
  id: string
  name: string
  unit: string | null
  stock: number | null
  tracked: boolean
}

/**
 * Инвентаризация товаров и расходников (055/056): ввести фактический
 * остаток → stock_take (остаток := факт, в журнал пишется дельта;
 * пустое поле = позиция не пересчитывается).
 */
export default function StockTakeSheet({ onClose }: { onClose: () => void }) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const { data: items = [] } = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })
  const { data: supplies = [] } = useQuery({ queryKey: ['supply_items'], queryFn: fetchSupplyItems })

  const [search, setSearch] = useState('')
  const [countedByKey, setCountedByKey] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')

  // Без поиска — учитываемые товары + все расходники; поиск — по всем
  const menuRows = useMemo<Row[]>(() => {
    const q = search.trim().toLowerCase()
    const list = q
      ? items.filter((i) => i.name.toLowerCase().includes(q))
      : items.filter((i) => i.track_inventory)
    return list.slice(0, 50).map((i) => ({ key: `menu:${i.id}`, kind: 'menu', id: i.id, name: i.name, unit: null, stock: i.stock, tracked: i.track_inventory }))
  }, [items, search])

  const supplyRows = useMemo<Row[]>(() => {
    const q = search.trim().toLowerCase()
    const list = q ? supplies.filter((s) => s.name.toLowerCase().includes(q)) : supplies
    return list.slice(0, 50).map((s) => ({ key: `supply:${s.id}`, kind: 'supply', id: s.id, name: s.name, unit: s.unit, stock: s.stock, tracked: true }))
  }, [supplies, search])

  const allRows = useMemo(() => new Map([...menuRows, ...supplyRows].map((r) => [r.key, r])), [menuRows, supplyRows])

  const filled = useMemo(
    () =>
      Object.entries(countedByKey)
        .map(([key, raw]) => ({ key, counted: raw.trim() === '' ? NaN : Number(raw) }))
        .filter((e) => Number.isInteger(e.counted) && e.counted >= 0 && allRows.has(e.key)),
    [countedByKey, allRows]
  )

  const save = useMutation({
    mutationFn: () => {
      const payload: CountItem[] = filled.map((e) => {
        const row = allRows.get(e.key)!
        return {
          kind: row.kind,
          ...(row.kind === 'menu' ? { menu_item_id: row.id } : { supply_item_id: row.id }),
          counted: e.counted,
        }
      })
      return stockTake(staff!.id, payload, note)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu_items'] })
      qc.invalidateQueries({ queryKey: ['supply_items'] })
      qc.invalidateQueries({ queryKey: ['stock_movements'] })
      qc.invalidateQueries({ queryKey: ['stock_report'] })
      toast.success(t(lang, 'stockTakeDone'))
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })

  function renderRow(row: Row) {
    const raw = countedByKey[row.key] ?? ''
    const counted = raw.trim() === '' ? null : Number(raw)
    const valid = counted != null && Number.isInteger(counted) && counted >= 0
    const delta = valid && row.tracked && row.stock != null ? counted - row.stock : null
    return (
      <div key={row.key} className="flex items-center gap-3 min-h-[56px] px-1 border-b border-gray-100">
        <span className={`flex-1 min-w-0 truncate text-sm ${valid ? 'font-bold' : ''} text-gray-900`}>
          <bdi>{row.name}</bdi>
          {row.tracked ? (
            <span className="font-normal text-gray-400 tabular-nums">
              {' '}· {row.stock ?? 0}{row.unit ? ` ${row.unit}` : ''}
            </span>
          ) : (
            valid && <span className="badge-blue ms-2 font-normal">{t(lang, 'receiveWillTrack')}</span>
          )}
        </span>
        {delta != null && delta !== 0 && (
          <span className={`shrink-0 text-sm font-bold tabular-nums ${delta > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {delta > 0 ? `+${delta}` : delta}
          </span>
        )}
        <input
          className="input !py-2 !w-24 text-center tabular-nums"
          inputMode="numeric"
          placeholder={t(lang, 'stockTakeCountedPh')}
          value={raw}
          onChange={(e) => setCountedByKey((p) => ({ ...p, [row.key]: e.target.value.replace(/[^\d]/g, '') }))}
        />
      </div>
    )
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
          <h2 className="flex-1 text-lg font-black text-gray-900">{t(lang, 'stockTakeTitle')}</h2>
          <button
            onClick={onClose}
            aria-label={t(lang, 'close')}
            className="w-11 h-11 rounded-xl hover:bg-gray-100 active:scale-[0.97] flex items-center justify-center text-xl text-gray-500"
          >
            ✕
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">{t(lang, 'stockTakeHint')}</p>

        <input
          className="input !py-2.5 mb-3"
          placeholder={t(lang, 'searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="mb-4 max-h-[46vh] overflow-y-auto">
          {menuRows.length > 0 && (
            <>
              <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mt-1 mb-1">{t(lang, 'items')}</div>
              {menuRows.map(renderRow)}
            </>
          )}
          {supplyRows.length > 0 && (
            <>
              <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mt-4 mb-1">{t(lang, 'suppliesTitle')}</div>
              {supplyRows.map(renderRow)}
            </>
          )}
        </div>

        {filled.length > 0 && (
          <input
            className="input !py-2.5 mb-3"
            placeholder={t(lang, 'stockTakeNotePh')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}

        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || filled.length === 0 || !staff}
          className="btn-primary w-full !py-3.5 !rounded-2xl disabled:opacity-40"
        >
          {t(lang, 'stockTakeBtn')}{filled.length > 0 ? ` · ${filled.length}` : ''}
        </button>
      </div>
    </div>
  )
}
