import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchTables, fetchOpenTableOrders, openTableOrder, setTableStatus, type TableOccupancy } from './api'
import { fetchCurrentLocation } from '../auth/api'
import { fetchCurrentShift } from '../shift/api'
import { useCartStore } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase'
import type { Table, TableStatus } from '../../types'
import AppSidebar from '../../components/AppSidebar'
import Icon from '../../components/Icon'
import ShiftGate from '../shift/ShiftGate'
import TableActionSheet from './TableActionSheet'
import TableEditSheet from './TableEditSheet'

export default function HallPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const navigate = useNavigate()
  const qc = useQueryClient()
  const cart = useCartStore()
  const staff = useAuthStore((s) => s.staff)

  const { data: shift, isLoading: shiftLoading } = useQuery({ queryKey: ['current_shift'], queryFn: fetchCurrentShift })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const { data: tables = [] } = useQuery({ queryKey: ['tables'], queryFn: fetchTables })
  const { data: open = [] } = useQuery({ queryKey: ['open_table_orders'], queryFn: fetchOpenTableOrders })

  // Тик раз в 30 сек — чтобы «сколько сидят» на карточках обновлялось само
  const [nowTs, setNowTs] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Realtime: заказ меняется → занятость; стол меняется → статус/справочник
  useEffect(() => {
    const ch = supabase
      .channel('hall')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () =>
        qc.invalidateQueries({ queryKey: ['open_table_orders'] })
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, () =>
        qc.invalidateQueries({ queryKey: ['tables'] })
      )
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [qc])

  const occupancyByTable = useMemo(() => {
    const map = new Map<string, (typeof open)[number]>()
    for (const o of open) map.set(o.table_id, o)
    return map
  }, [open])

  // Группировка по зонам (без зоны → «—»)
  const zones = useMemo(() => {
    const byZone = new Map<string, typeof tables>()
    for (const tb of tables) {
      const z = tb.zone || ''
      if (!byZone.has(z)) byZone.set(z, [])
      byZone.get(z)!.push(tb)
    }
    return [...byZone.entries()]
  }, [tables])

  // Занятый стол, по которому открыто меню действий (долгий тап)
  const [actionTable, setActionTable] = useState<{ table: Table; occ: TableOccupancy } | null>(null)
  // Незанятый стол, по которому открыто управление статусом (долгий тап)
  const [statusTable, setStatusTable] = useState<Table | null>(null)
  // Режим редактирования зала (manager+): создание/переименование/удаление столов
  const [editMode, setEditMode] = useState(false)
  // Открытый редактор стола: существующий Table или { zone } для нового
  const [editTable, setEditTable] = useState<Table | { zone: string | null } | null>(null)
  const isManager = staff?.role === 'owner' || staff?.role === 'manager'
  // Долгий тап: таймер + флаг, чтобы подавить click после срабатывания
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdFired = useRef(false)

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TableStatus }) => setTableStatus(id, status),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tables'] }); setStatusTable(null) },
    onError: (e) => toast.error(e.message),
  })

  function startHold(tb: Table) {
    holdFired.current = false
    const occ = occupancyByTable.get(tb.id)
    holdTimer.current = setTimeout(() => {
      holdFired.current = true
      // Занятый стол → меню действий; свободный/резерв/недоступный → статус
      if (occ) setActionTable({ table: tb, occ })
      else setStatusTable(tb)
    }, 500)
  }
  function cancelHold() {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
  }

  async function openTable(tableId: string, tableLabel: string) {
    if (holdFired.current) return // это был долгий тап — click игнорируем
    if (!staff) return
    try {
      const res = await openTableOrder(tableId, staff.id)
      cart.clear()
      cart.setTableCtx({ tableId, orderId: res.order_id, tableLabel, existingTotal: res.total })
      navigate('/sell')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!shiftLoading && !shift) return <ShiftGate />

  const modeOk = location?.service_mode === 'tables'

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="hall" />

      <main className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-black text-gray-900">{t(lang, 'hall')}</h1>
          {modeOk && isManager && (
            <button
              onClick={() => setEditMode((v) => !v)}
              className={editMode ? 'btn-primary !py-2 !px-4' : 'btn-secondary !py-2 !px-4'}
            >
              {editMode ? t(lang, 'done') : t(lang, 'edit')}
            </button>
          )}
        </div>

        {!modeOk ? (
          <p className="text-gray-400 text-sm">{t(lang, 'serviceModeHint')}</p>
        ) : tables.length === 0 && !editMode ? (
          <div className="text-center pt-24">
            <p className="font-bold text-gray-900">{t(lang, 'hallEmpty')}</p>
            <p className="text-sm text-gray-500 mt-1">
              {isManager ? t(lang, 'hallEmptyHintEdit') : t(lang, 'hallEmptyHint')}
            </p>
            {isManager && (
              <button onClick={() => setEditMode(true)} className="btn-primary !py-2 !px-5 mt-4">
                {t(lang, 'edit')}
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {/* Пустой зал в режиме редактирования: одна зона без имени, чтобы была кнопка «+» */}
            {(zones.length === 0 ? [['', []]] as [string, Table[]][] : zones).map(([zone, zTables]) => (
              <section key={zone}>
                {zone && <h2 className="text-sm font-bold text-gray-500 mb-3">{zone}</h2>}
                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                  {zTables.map((tb) => {
                    const occ = occupancyByTable.get(tb.id)
                    const busy = !!occ
                    const disabled = !busy && tb.status === 'disabled'
                    const reserved = !busy && tb.status === 'reserved'
                    // Приоритет рамки: занят(красный) > резерв(синий) > недоступен(серый) > свободен(зелёный)
                    const border = busy
                      ? 'border-red-500'
                      : reserved
                        ? 'border-blue-500'
                        : disabled
                          ? 'border-gray-200 opacity-50'
                          : 'border-emerald-500 hover:border-emerald-600'
                    return (
                      <button
                        key={tb.id}
                        onClick={() => {
                          if (editMode) { setEditTable(tb); return }
                          if (!disabled) openTable(tb.id, tb.label)
                        }}
                        onPointerDown={() => { if (!editMode) startHold(tb) }}
                        onPointerUp={cancelHold}
                        onPointerLeave={cancelHold}
                        onContextMenu={(e) => e.preventDefault()}
                        className={`relative aspect-square rounded-2xl border-2 bg-white p-3 flex flex-col items-center justify-center gap-1 transition-all active:scale-[0.97] select-none text-gray-900 ${
                          editMode ? 'border-dashed border-gray-300 hover:border-gray-500' : border
                        }`}
                      >
                        {editMode && (
                          <span className="absolute top-2 end-2 text-gray-400">
                            <Icon name="settings" size={14} />
                          </span>
                        )}
                        <span className="text-2xl font-black tabular-nums leading-none">{tb.label}</span>
                        {editMode ? (
                          <span className="text-[11px] text-gray-400">{tb.zone || t(lang, 'tableTapToEdit')}</span>
                        ) : busy ? (
                          <>
                            {/* Сумма в углу — не смещает центрированный номер */}
                            <span className="absolute top-3 end-3 text-sm font-bold tabular-nums text-red-500 leading-none">
                              {formatMoney(occ!.total, lang)}
                            </span>
                            <div className="absolute bottom-3 start-3 text-start space-y-0.5">
                              <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                                <span className="tabular-nums">{elapsedShort(occ!.opened_at, nowTs, lang)}</span>
                                <span className="text-gray-300">·</span>
                                <span className="tabular-nums">{occ!.item_count} {t(lang, 'itemsShort')}</span>
                              </div>
                              {occ!.staff_name && (
                                <div className="text-[11px] text-gray-400 truncate max-w-[90%]">{occ!.staff_name}</div>
                              )}
                            </div>
                          </>
                        ) : reserved ? (
                          <span className="text-[11px] font-semibold text-blue-500">{t(lang, 'tableReserved')}</span>
                        ) : disabled ? (
                          <span className="text-[11px] text-gray-400">{t(lang, 'tableDisabled')}</span>
                        ) : (
                          <span className="text-[11px] text-emerald-600">{t(lang, 'tableFree')}</span>
                        )}
                      </button>
                    )
                  })}

                  {/* Плитка добавления стола в эту зону */}
                  {editMode && (
                    <button
                      onClick={() => setEditTable({ zone: zone || null })}
                      className="aspect-square rounded-2xl border-2 border-dashed border-gray-300 flex flex-col items-center justify-center gap-1 text-gray-400 hover:border-gray-500 hover:text-gray-600 transition-all active:scale-[0.97]"
                    >
                      <span className="text-3xl font-light leading-none">+</span>
                      <span className="text-[11px] font-semibold">{t(lang, 'addTable')}</span>
                    </button>
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {actionTable && (
        <TableActionSheet
          table={actionTable.table}
          occ={actionTable.occ}
          tables={tables}
          occupancy={occupancyByTable}
          onOpenBill={() => { holdFired.current = false; setActionTable(null); openTable(actionTable.table.id, actionTable.table.label) }}
          onClose={() => setActionTable(null)}
        />
      )}

      {statusTable && (
        <div
          dir={isRtl ? 'rtl' : 'ltr'}
          className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
          onClick={() => setStatusTable(null)}
        >
          <div className="card w-full max-w-xs p-6 animate-[rise-in_0.2s_ease-out]" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-black text-gray-900 mb-4">
              {t(lang, 'tableLabel')} {statusTable.label}
            </h2>
            <div className="space-y-2">
              {([
                { s: 'free', label: t(lang, 'tableFree'), dot: 'bg-emerald-500' },
                { s: 'reserved', label: t(lang, 'tableReserved'), dot: 'bg-blue-500' },
                { s: 'disabled', label: t(lang, 'tableDisabled'), dot: 'bg-gray-400' },
              ] as const).map(({ s, label, dot }) => (
                <button
                  key={s}
                  onClick={() => statusMut.mutate({ id: statusTable.id, status: s })}
                  disabled={statusMut.isPending}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl border text-start text-sm font-semibold transition-all active:scale-[0.98] disabled:opacity-50 ${
                    statusTable.status === s ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-400'
                  }`}
                >
                  <span className={`w-3 h-3 rounded-full ${dot}`} />
                  {label}
                </button>
              ))}
            </div>
            <button onClick={() => setStatusTable(null)} className="btn-ghost w-full mt-3">
              {t(lang, 'cancel')}
            </button>
          </div>
        </div>
      )}

      {editTable && (
        <TableEditSheet
          target={editTable}
          nextSortOrder={tables.reduce((m, tb) => Math.max(m, tb.sort_order), 0) + 1}
          onClose={() => setEditTable(null)}
        />
      )}
    </div>
  )
}

/** Компактное «сколько прошло»: «5 мин», «1 ч 20 мин». nowTs — для реактивности. */
function elapsedShort(iso: string, nowTs: number, lang: 'ru' | 'he'): string {
  const mins = Math.max(0, Math.floor((nowTs - new Date(iso).getTime()) / 60000))
  if (mins < 1) return t(lang, 'justNow')
  if (mins < 60) return `${mins} ${t(lang, 'minShort')}`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0
    ? `${h} ${t(lang, 'hourShort')}`
    : `${h} ${t(lang, 'hourShort')} ${m} ${t(lang, 'minShort')}`
}
