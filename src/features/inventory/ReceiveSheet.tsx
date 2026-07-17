import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchItems } from '../menu/api'
import {
  fetchSupplyItems, receiveStock, upsertSupplyItem, isFractionalUnit, SUPPLY_UNITS,
  fetchSuppliers, upsertSupplier, fetchPackagings, costDivisor,
  type Packaging, type ReceiveItem, type StockKind,
} from './api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'

/** Строка списка: товар меню или расходник, приведённые к общему виду */
interface Row {
  key: string // `${kind}:${id}` — уникальный ключ для стейта
  kind: StockKind
  id: string
  name: string
  unit: string | null
  stock: number | null
  cost: number | null
  tracked: boolean // товар: track_inventory; расходник: всегда true
}

/**
 * Приход товара и расходников (055/056): степперы по позициям →
 * receive_stock (+qty, снапшот закупочной цены, опц. обновляет cost).
 * Расходник можно завести на лету («+ Новый расходник»).
 */
export default function ReceiveSheet({ onClose }: { onClose: () => void }) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const { data: items = [] } = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })
  const { data: supplies = [] } = useQuery({ queryKey: ['supply_items'], queryFn: fetchSupplyItems })
  const { data: suppliers = [] } = useQuery({ queryKey: ['suppliers'], queryFn: fetchSuppliers })
  const { data: packagings = [] } = useQuery({ queryKey: ['supply_packagings'], queryFn: fetchPackagings })

  const [search, setSearch] = useState('')
  const [qtyByKey, setQtyByKey] = useState<Record<string, number>>({})
  const [costByKey, setCostByKey] = useState<Record<string, string>>({})
  const [updateCostByKey, setUpdateCostByKey] = useState<Record<string, boolean>>({})
  const [note, setNote] = useState('')
  const [newName, setNewName] = useState('')
  const [newUnit, setNewUnit] = useState<string>('шт')
  const [adding, setAdding] = useState(false)
  // Накладная (077): UUID создаётся при открытии шита и переживает
  // retry — повтор после timeout идемпотентен на сервере
  const [docId] = useState(() => crypto.randomUUID())
  const [supplierId, setSupplierId] = useState('')
  const [docNo, setDocNo] = useState('')
  const [addingSupplier, setAddingSupplier] = useState(false)
  const [newSupName, setNewSupName] = useState('')
  const [newSupPhone, setNewSupPhone] = useState('')

  const packagingsByItem = useMemo(() => {
    const m: Record<string, Packaging[]> = {}
    for (const p of packagings) (m[p.supply_item_id] ??= []).push(p)
    return m
  }, [packagings])

  const UNIT_LABELS: Record<string, string> = {
    'шт': t(lang, 'unitPcs'), 'г': t(lang, 'unitG'), 'мл': t(lang, 'unitMl'),
  }

  const menuRows = useMemo<Row[]>(
    () => items.map((i) => ({ key: `menu:${i.id}`, kind: 'menu', id: i.id, name: i.name, unit: null, stock: i.stock, cost: i.cost, tracked: i.track_inventory })),
    [items]
  )
  const supplyRows = useMemo<Row[]>(
    () => supplies.map((s) => ({ key: `supply:${s.id}`, kind: 'supply', id: s.id, name: s.name, unit: s.unit, stock: s.stock, cost: s.cost, tracked: true })),
    [supplies]
  )

  function filterRows(rows: Row[]): Row[] {
    const q = search.trim().toLowerCase()
    const list = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows
    return list.slice(0, 50)
  }

  const totalQty = Object.values(qtyByKey).reduce((s, n) => s + n, 0)
  const hasBadCost = Object.entries(costByKey).some(
    ([key, raw]) => (qtyByKey[key] ?? 0) > 0 && raw.trim() !== '' && parseMoney(raw) == null
  )

  function bump(key: string, delta: number) {
    setQtyByKey((prev) => {
      const next = { ...prev, [key]: Math.max((prev[key] ?? 0) + delta, 0) }
      if (next[key] === 0) delete next[key]
      return next
    })
  }

  const addSupply = useMutation({
    mutationFn: () => upsertSupplyItem(null, newName.trim(), newUnit || null, null),
    onSuccess: () => {
      setNewName('')
      setNewUnit('шт')
      setAdding(false)
      qc.invalidateQueries({ queryKey: ['supply_items'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const addSupplier = useMutation({
    mutationFn: () => upsertSupplier(null, newSupName.trim(), newSupPhone.trim() || null),
    onSuccess: (id) => {
      setSupplierId(id)
      setNewSupName('')
      setNewSupPhone('')
      setAddingSupplier(false)
      qc.invalidateQueries({ queryKey: ['suppliers'] })
    },
    onError: (e) => toast.error(e.message),
  })

  // Сумма прихода по введённым ценам (конвенция cost: г/мл — за 1000)
  const totalCost = useMemo(() => {
    const rowByKey = new Map([...menuRows, ...supplyRows].map((r) => [r.key, r]))
    let sum = 0
    for (const [key, qty] of Object.entries(qtyByKey)) {
      const row = rowByKey.get(key)
      const cost = parseMoney(costByKey[key] ?? '')
      if (!row || qty <= 0 || cost == null) continue
      sum += Math.round((qty * cost) / (row.kind === 'supply' ? costDivisor(row.unit) : 1))
    }
    return sum
  }, [qtyByKey, costByKey, menuRows, supplyRows])

  const save = useMutation({
    mutationFn: () => {
      const rowByKey = new Map([...menuRows, ...supplyRows].map((r) => [r.key, r]))
      const payload: ReceiveItem[] = Object.entries(qtyByKey).map(([key, qty]) => {
        const row = rowByKey.get(key)!
        const cost = parseMoney(costByKey[key] ?? '')
        return {
          kind: row.kind,
          ...(row.kind === 'menu' ? { menu_item_id: row.id } : { supply_item_id: row.id }),
          qty,
          unit_cost: cost,
          update_cost: cost != null && !!updateCostByKey[key],
        }
      })
      return receiveStock(staff!.id, payload, note, supplierId || null, docNo, docId)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu_items'] })
      qc.invalidateQueries({ queryKey: ['supply_items'] })
      qc.invalidateQueries({ queryKey: ['stock_movements'] })
      qc.invalidateQueries({ queryKey: ['stock_report'] })
      qc.invalidateQueries({ queryKey: ['supply_docs'] })
      toast.success(t(lang, 'receiveDone'))
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })

  function renderRow(row: Row) {
    const qty = qtyByKey[row.key] ?? 0
    // Граммы/миллилитры степпером не набрать — прямой ввод в базовых единицах
    const fractional = row.kind === 'supply' && isFractionalUnit(row.unit)
    return (
      <div key={row.key} className="border-b border-gray-100">
        <div className="flex items-center gap-2 min-h-[48px] px-1">
          <span className={`flex-1 min-w-0 truncate text-sm ${qty > 0 ? 'font-bold' : ''} text-gray-900`}>
            <bdi>{row.name}</bdi>
            {row.tracked && row.stock != null && (
              <span className="font-normal text-gray-400 tabular-nums"> · {row.stock}{row.unit ? ` ${row.unit}` : ''}</span>
            )}
            {row.kind === 'menu' && !row.tracked && qty > 0 && (
              <span className="badge-blue ms-2 font-normal">{t(lang, 'receiveWillTrack')}</span>
            )}
          </span>
          {fractional ? (
            <>
              <input
                className="input !py-2 !w-24 text-center tabular-nums"
                inputMode="numeric"
                value={qty || ''}
                onChange={(e) => {
                  const n = Math.min(1000000, parseInt(e.target.value.replace(/\D/g, ''), 10) || 0)
                  setQtyByKey((prev) => {
                    const next = { ...prev, [row.key]: n }
                    if (n === 0) delete next[row.key]
                    return next
                  })
                }}
              />
              <span className="w-8 text-xs text-gray-500">{row.unit}</span>
            </>
          ) : (
            <>
              <button
                onClick={() => bump(row.key, -1)}
                disabled={qty === 0}
                className="w-11 h-11 rounded-xl border border-gray-200 font-bold text-gray-900 disabled:opacity-30 active:scale-[0.94]"
              >
                −
              </button>
              <span className="w-8 text-center font-bold tabular-nums text-gray-900">{qty || ''}</span>
              <button
                onClick={() => bump(row.key, 1)}
                className="w-11 h-11 rounded-xl border border-gray-200 font-bold text-gray-900 active:scale-[0.94]"
              >
                +
              </button>
            </>
          )}
        </div>
        {/* Фасовки: тап добавляет объём упаковки к количеству (077) */}
        {row.kind === 'supply' && (packagingsByItem[row.id]?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-2 px-1">
            {packagingsByItem[row.id].map((p) => (
              <button
                key={p.id}
                onClick={() => bump(row.key, p.qty)}
                className="h-11 px-4 rounded-xl bg-gray-100 text-sm font-semibold text-gray-700 active:scale-[0.95]"
              >
                +{p.name}
              </button>
            ))}
          </div>
        )}
        {qty > 0 && (
          <div className="flex items-center gap-3 pb-3 px-1">
            <input
              className="input !py-2 !w-32 text-sm"
              inputMode="decimal"
              placeholder={
                fractional
                  ? t(lang, row.unit === 'мл' ? 'costPerLPh' : 'costPerKgPh')
                  : row.cost != null ? formatMoney(row.cost, lang) : t(lang, 'receiveCostPh')
              }
              value={costByKey[row.key] ?? ''}
              onChange={(e) => setCostByKey((p) => ({ ...p, [row.key]: e.target.value }))}
            />
            <label className="flex items-center gap-2 text-sm text-gray-500 min-h-[44px] cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-5 h-5 accent-gray-900"
                disabled={parseMoney(costByKey[row.key] ?? '') == null}
                checked={!!updateCostByKey[row.key] && parseMoney(costByKey[row.key] ?? '') != null}
                onChange={(e) => setUpdateCostByKey((p) => ({ ...p, [row.key]: e.target.checked }))}
              />
              {t(lang, 'receiveUpdateCost')}
            </label>
          </div>
        )}
      </div>
    )
  }

  const menuVisible = filterRows(menuRows)
  const supplyVisible = filterRows(supplyRows)

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
          <h2 className="flex-1 text-lg font-black text-gray-900">{t(lang, 'receiveTitle')}</h2>
          <button
            onClick={onClose}
            aria-label={t(lang, 'close')}
            className="w-11 h-11 rounded-xl hover:bg-gray-100 active:scale-[0.97] flex items-center justify-center text-xl text-gray-500"
          >
            ✕
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-1">{t(lang, 'receiveHint')}</p>
        <p className="text-xs text-gray-400 mb-4">{t(lang, 'receiveAvgCostHint')}</p>

        {/* Поставщик и номер накладной (077) */}
        <div className="flex items-center gap-2 mb-2">
          <select
            className="input !py-2.5 flex-1 text-sm"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
          >
            <option value="">{t(lang, 'supplierNone')}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input
            className="input !py-2.5 !w-36 text-sm"
            placeholder={t(lang, 'docNoPh')}
            value={docNo}
            onChange={(e) => setDocNo(e.target.value)}
          />
          <button
            onClick={() => setAddingSupplier((v) => !v)}
            aria-label={t(lang, 'supplierAddBtn')}
            className="w-11 h-11 shrink-0 rounded-xl border border-gray-200 font-bold text-gray-900 active:scale-[0.94]"
          >
            +
          </button>
        </div>
        {addingSupplier && (
          <div className="flex items-center gap-2 mb-2">
            <input
              className="input !py-2 flex-1 text-sm"
              placeholder={t(lang, 'supplierNamePh')}
              value={newSupName}
              onChange={(e) => setNewSupName(e.target.value)}
              autoFocus
            />
            <input
              className="input !py-2 !w-36 text-sm"
              inputMode="tel"
              placeholder={t(lang, 'supplierPhonePh')}
              value={newSupPhone}
              onChange={(e) => setNewSupPhone(e.target.value)}
            />
            <button
              onClick={() => addSupplier.mutate()}
              disabled={addSupplier.isPending || newSupName.trim() === ''}
              className="btn-primary !py-2 !px-4 disabled:opacity-40"
            >
              {t(lang, 'save')}
            </button>
          </div>
        )}

        <input
          className="input !py-2.5 mb-3"
          placeholder={t(lang, 'searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="mb-4 max-h-[42vh] overflow-y-auto">
          {menuVisible.length > 0 && (
            <>
              <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mt-1 mb-1">{t(lang, 'items')}</div>
              {menuVisible.map(renderRow)}
            </>
          )}

          <div className="flex items-center justify-between mt-4 mb-1">
            <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">{t(lang, 'suppliesTitle')}</span>
            <button onClick={() => setAdding((v) => !v)} className="text-sm font-semibold text-gray-900 hover:underline">
              {t(lang, 'supplyAddBtn')}
            </button>
          </div>
          {adding && (
            <div className="flex items-center gap-2 mb-2">
              <input
                className="input !py-2 flex-1 text-sm"
                placeholder={t(lang, 'supplyNamePh')}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
              />
              <select
                className="input !py-2 !w-24 text-sm"
                value={newUnit}
                onChange={(e) => setNewUnit(e.target.value)}
              >
                {SUPPLY_UNITS.map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
              </select>
              <button
                onClick={() => addSupply.mutate()}
                disabled={addSupply.isPending || newName.trim() === ''}
                className="btn-primary !py-2 !px-4 disabled:opacity-40"
              >
                {t(lang, 'save')}
              </button>
            </div>
          )}
          {supplyVisible.length > 0 ? (
            supplyVisible.map(renderRow)
          ) : (
            !adding && <div className="text-sm text-gray-400 py-2">{t(lang, 'suppliesEmpty')}</div>
          )}
        </div>

        {totalQty > 0 && (
          <input
            className="input !py-2.5 mb-3"
            placeholder={t(lang, 'receiveNotePh')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}

        {totalCost > 0 && (
          <div className="flex items-center justify-between text-sm mb-3 px-1">
            <span className="text-gray-500">{t(lang, 'receiveTotalLabel')}</span>
            <span className="font-bold text-gray-900 tabular-nums">{formatMoney(totalCost, lang)}</span>
          </div>
        )}

        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || totalQty === 0 || hasBadCost || !staff}
          className="btn-primary w-full !py-3.5 !rounded-2xl disabled:opacity-40"
        >
          {t(lang, 'receiveBtn')}{totalQty > 0 ? ` · ${totalQty}` : ''}
        </button>
      </div>
    </div>
  )
}
