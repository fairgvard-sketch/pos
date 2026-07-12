import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchTables, fetchOpenTableOrders, openTableOrder, setTableStatus, setTableLayout, type TableOccupancy } from './api'
import { fetchUpcomingTableReservations } from '../reservations/api'
import { fetchCurrentLocation } from '../auth/api'
import { fetchCurrentShift } from '../shift/api'
import { useCartStore } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t, formatElapsed, formatTime } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import { OfflineError, withOfflineFallback } from '../../lib/offline/net'
import { useOutboxStore } from '../../lib/offline/outboxStore'
import { enqueueTableOpen } from '../../lib/offline/enqueue'
import type { Table, TableStatus } from '../../types'
import AppSidebar from '../../components/AppSidebar'
import Icon from '../../components/Icon'
import ShiftGate from '../shift/ShiftGate'
import TableActionSheet from './TableActionSheet'
import TableEditSheet from './TableEditSheet'

/** Порог «стол сидит долго» (мин): до него жёлтая рамка, после — красная */
const TABLE_WARN_MIN = 30

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
  // Брони «скоро» (053): окно now−30мин..now+2ч вычисляется в queryFn,
  // поэтому перезапрашиваем раз в минуту — граница окна ползёт со временем
  const { data: upcomingRes = [] } = useQuery({
    queryKey: ['reservations_today'],
    queryFn: fetchUpcomingTableReservations,
    refetchInterval: 60_000,
  })

  // Тик раз в 30 сек — чтобы «сколько сидят» на карточках обновлялось само
  const [nowTs, setNowTs] = useState(() => Date.now())
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, () =>
        qc.invalidateQueries({ queryKey: ['reservations_today'] })
      )
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [qc])

  // Офлайн (фаза 7): столы, открытые без сети, живут в локальном эхе
  const localOrders = useOutboxStore((s) => s.localOrders)

  const occupancyByTable = useMemo(() => {
    const map = new Map<string, (typeof open)[number]>()
    for (const o of open) map.set(o.table_id, o)
    // Эхо офлайн-столов: стол занят, пока счёт не оплачен/не отменён
    for (const lo of Object.values(localOrders)) {
      if (lo.kind !== 'table' || lo.status === 'synced' || !lo.tableId || lo.receipt) continue
      if (lo.serverOrderId !== null || map.has(lo.tableId)) continue
      map.set(lo.tableId, {
        table_id: lo.tableId,
        order_id: lo.key,
        total: lo.total,
        daily_number: 0,
        opened_at: lo.createdAt,
        staff_name: null,
        item_count: lo.lines.reduce((s, l) => s + l.qty, 0),
      })
    }
    return map
  }, [open, localOrders])

  // Ближайшая confirmed-бронь по столу — синяя подсветка с временем.
  // Список отсортирован по reserved_at, первый и есть ближайший.
  const reservationByTable = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of upcomingRes) {
      if (r.table_id && !map.has(r.table_id)) map.set(r.table_id, r.reserved_at)
    }
    return map
  }, [upcomingRes])

  // Раскладка на холсте: у неразмещённых столов (pos_x=null) — дефолтная
  // сетка, чтобы их можно было увидеть и растащить. Размещённые — как есть.
  const layout = useMemo(() => tablesWithLayout(tables), [tables])

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

  // ── Drag столов по плану (только в режиме редактирования) ──
  const canvasRef = useRef<HTMLDivElement | null>(null)
  // Локальный оверрайд позиции таскаемого стола (%), чтобы не ждать сеть
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null)
  const dragMoved = useRef(false)
  // Локальный оверрайд размера (%) при ресайзе. axis: обе оси / ширина / высота
  const [resize, setResize] = useState<
    { id: string; width: number; height: number; cx: number; cy: number; axis: 'both' | 'x' | 'y' } | null
  >(null)

  const MIN_W = 5, MAX_W = 30   // ширина стола, % холста
  const MIN_H = 5, MAX_H = 40   // высота стола, % холста

  const layoutMut = useMutation({
    mutationFn: ({ id, x, y, width, height }: { id: string; x: number; y: number; width?: number; height?: number }) =>
      setTableLayout(id, x, y, width, undefined, height),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tables'] }),
    onError: (e) => toast.error(e.message),
  })

  function startDrag(e: React.PointerEvent, tb: Table, x: number, y: number) {
    if (!editMode) return
    e.stopPropagation()
    dragMoved.current = false
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDragPos({ id: tb.id, x, y })
  }
  function onDragMove(e: React.PointerEvent) {
    if (resize && canvasRef.current) { onResizeMove(e); return }
    if (!dragPos || !canvasRef.current) return
    const r = canvasRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100))
    const y = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100))
    dragMoved.current = true
    setDragPos({ id: dragPos.id, x, y })
  }
  function endDrag() {
    if (resize) { endResize(); return }
    if (dragPos && dragMoved.current) {
      layoutMut.mutate({ id: dragPos.id, x: dragPos.x, y: dragPos.y })
    }
    setDragPos(null)
  }

  // Ресайз: размер = 2 × расстояние от курсора до центра (в % холста).
  // axis 'both' — угол (обе оси), 'x' — правый край, 'y' — нижний край.
  function startResize(e: React.PointerEvent, tb: Table, cx: number, cy: number, axis: 'both' | 'x' | 'y') {
    e.stopPropagation()
    dragMoved.current = false
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setResize({ id: tb.id, width: tb.width, height: tb.height, cx, cy, axis })
  }
  function onResizeMove(e: React.PointerEvent) {
    if (!resize || !canvasRef.current) return
    const r = canvasRef.current.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * 100
    const py = ((e.clientY - r.top) / r.height) * 100
    const nextW = Math.max(MIN_W, Math.min(MAX_W, Math.abs(px - resize.cx) * 2))
    const nextH = Math.max(MIN_H, Math.min(MAX_H, Math.abs(py - resize.cy) * 2))
    dragMoved.current = true  // подавить клик по столу после ресайза
    setResize({
      ...resize,
      width: resize.axis === 'y' ? resize.width : nextW,
      height: resize.axis === 'x' ? resize.height : nextH,
    })
  }
  function endResize() {
    if (resize) {
      const tb = tables.find((t) => t.id === resize.id)
      const x = tb?.pos_x ?? layout.find((l) => l.table.id === resize.id)?.x ?? 50
      const y = tb?.pos_y ?? layout.find((l) => l.table.id === resize.id)?.y ?? 50
      layoutMut.mutate({ id: resize.id, x, y, width: resize.width, height: resize.height })
    }
    setResize(null)
  }

  function startHold(tb: Table) {
    holdFired.current = false
    const occ = occupancyByTable.get(tb.id)
    holdTimer.current = setTimeout(() => {
      holdFired.current = true
      // Занятый стол → меню действий; свободный/резерв/недоступный → статус.
      // Локальное эхо (стол открыт офлайн): перенос/слияние требуют сервера
      if (occ) {
        if (useOutboxStore.getState().localOrders[occ.order_id]) {
          toast.error(t(lang, 'offlineBlockedHint'))
          return
        }
        setActionTable({ table: tb, occ })
      } else setStatusTable(tb)
    }, 500)
  }
  function cancelHold() {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
  }

  async function openTable(tableId: string, tableLabel: string) {
    if (holdFired.current) return // это был долгий тап — click игнорируем
    if (!staff) return

    // Стол уже открыт офлайн (локальное эхо) → входим в него, без сети
    const echo = Object.values(useOutboxStore.getState().localOrders).find(
      (lo) => lo.kind === 'table' && lo.tableId === tableId && lo.status !== 'synced' && !lo.receipt && lo.serverOrderId === null
    )
    if (echo) {
      cart.clear()
      cart.setTableCtx({ tableId, orderId: echo.key, tableLabel, existingTotal: echo.total })
      navigate('/sell')
      return
    }

    try {
      const res = await withOfflineFallback(() => openTableOrder(tableId, staff.id))
      cart.clear()
      cart.setTableCtx({ tableId, orderId: res.order_id, tableLabel, existingTotal: res.total })
      navigate('/sell')
    } catch (e) {
      if (e instanceof OfflineError) {
        // Серверный счёт этого стола известен из кэша зала → входим офлайн
        const occ = occupancyByTable.get(tableId)
        if (occ) {
          cart.clear()
          cart.setTableCtx({ tableId, orderId: occ.order_id, tableLabel, existingTotal: occ.total })
          navigate('/sell')
          return
        }
        // Свободный стол → открываем офлайн: эхо + операция в очередь
        const key = crypto.randomUUID()
        enqueueTableOpen({ key, tableId, tableLabel, staffId: staff.id })
        cart.clear()
        cart.setTableCtx({ tableId, orderId: key, tableLabel, existingTotal: 0 })
        navigate('/sell')
        return
      }
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
          <p className="text-gray-500 text-sm">{t(lang, 'serviceModeHint')}</p>
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
          <>
            {editMode && (
              <div className="flex items-center gap-3 mb-3">
                <button onClick={() => setEditTable({ zone: null })} className="btn-secondary !py-2 !px-4">
                  {t(lang, 'addTable')}
                </button>
                <span className="text-xs text-gray-400">{t(lang, 'hallEditHint')}</span>
              </div>
            )}

            {/* Холст плана: столы позиционируются в % от его размера */}
            <div
              ref={canvasRef}
              onPointerMove={editMode ? onDragMove : undefined}
              onPointerUp={editMode ? endDrag : undefined}
              className={`relative w-full aspect-[16/10] rounded-2xl ${
                editMode ? 'bg-gray-50 ring-1 ring-inset ring-gray-200' : ''
              }`}
            >
              {layout.map(({ table: tb, x: baseX, y: baseY }) => {
                const dp = dragPos?.id === tb.id ? dragPos : null
                const x = dp ? dp.x : baseX
                const y = dp ? dp.y : baseY
                const rz = resize?.id === tb.id ? resize : null
                const w = rz ? rz.width : tb.width
                const h = rz ? rz.height : tb.height
                const occ = occupancyByTable.get(tb.id)
                const busy = !!occ
                const disabled = !busy && tb.status === 'disabled'
                // Резерв: ручной флаг стола ИЛИ подтверждённая бронь в ближайшие 2ч
                const upcomingAt = reservationByTable.get(tb.id)
                const reserved = !busy && (tb.status === 'reserved' || !!upcomingAt)
                // Возраст счёта красит стол: до 30 мин — жёлтый, дальше — красный
                const ageMin = occ ? Math.floor((nowTs - new Date(occ.opened_at).getTime()) / 60000) : 0
                const overdue = ageMin >= TABLE_WARN_MIN
                const border = busy
                  ? overdue ? 'border-red-500' : 'border-amber-400'
                  : reserved
                    ? 'border-blue-500'
                    : disabled
                      ? 'border-gray-200 opacity-50'
                      : 'border-emerald-500 hover:border-emerald-600'
                return (
                  <button
                    key={tb.id}
                    onClick={() => {
                      if (dragMoved.current) return  // это был drag, не клик
                      if (editMode) { setEditTable(tb); return }
                      if (!disabled) openTable(tb.id, tb.label)
                    }}
                    onPointerDown={(e) => {
                      if (editMode) startDrag(e, tb, baseX, baseY)
                      else startHold(tb)
                    }}
                    onPointerUp={cancelHold}
                    onPointerLeave={cancelHold}
                    onContextMenu={(e) => e.preventDefault()}
                    style={{
                      left: `${x}%`,
                      top: `${y}%`,
                      width: `${w}%`,
                      height: `${h}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                    className={`absolute border-2 bg-white p-2 flex flex-col items-center justify-center gap-0.5 transition-shadow select-none text-gray-900 ${
                      tb.shape === 'circle' ? 'rounded-full' : 'rounded-2xl'
                    } ${editMode ? `border-dashed ${dp || rz ? 'shadow-lg z-10' : 'cursor-grab'} border-gray-400` : `${border} active:scale-[0.97]`}`}
                  >
                    {editMode && (
                      <>
                        {/* Правый край — ширина */}
                        <span
                          onPointerDown={(e) => startResize(e, tb, x, y, 'x')}
                          onPointerMove={onResizeMove}
                          onPointerUp={endResize}
                          className="absolute top-1/2 -end-1.5 -translate-y-1/2 w-3 h-6 rounded-full bg-white border-2 border-gray-400 cursor-ew-resize z-20"
                        />
                        {/* Нижний край — высота */}
                        <span
                          onPointerDown={(e) => startResize(e, tb, x, y, 'y')}
                          onPointerMove={onResizeMove}
                          onPointerUp={endResize}
                          className="absolute -bottom-1.5 start-1/2 -translate-x-1/2 w-6 h-3 rounded-full bg-white border-2 border-gray-400 cursor-ns-resize z-20"
                        />
                        {/* Угол — обе оси */}
                        <span
                          onPointerDown={(e) => startResize(e, tb, x, y, 'both')}
                          onPointerMove={onResizeMove}
                          onPointerUp={endResize}
                          className="absolute -bottom-1.5 -end-1.5 w-4 h-4 rounded-full bg-white border-2 border-gray-500 cursor-nwse-resize z-20"
                        />
                      </>
                    )}
                    {editMode && (
                      <span className="absolute top-1.5 end-1.5 text-gray-400">
                        <Icon name="settings" size={13} />
                      </span>
                    )}
                    <span className="text-xl font-black tabular-nums leading-none">{tb.label}</span>
                    {/* Карточка чистая: только статус, детали — в окне стола (долгий тап) */}
                    {editMode ? null : busy ? (
                      <span className={`text-[11px] font-semibold ${overdue ? 'text-red-500' : 'text-amber-600'}`}>
                        {t(lang, 'tableBusy')} · {formatElapsed(occ!.opened_at, nowTs, lang)}
                      </span>
                    ) : reserved ? (
                      <span className="text-[11px] font-semibold text-blue-500">
                        {t(lang, 'tableReserved')}
                        {upcomingAt && <> · {formatTime(upcomingAt, lang)}</>}
                      </span>
                    ) : disabled ? (
                      <span className="text-[11px] text-gray-400">{t(lang, 'tableDisabled')}</span>
                    ) : (
                      <span className="text-[11px] text-emerald-600">{t(lang, 'tableFree')}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </>
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

/**
 * Позиции столов на холсте (%). Размещённые (pos_x!=null) — как есть.
 * Неразмещённые раскладываем дефолтной сеткой в свободные слоты, чтобы их
 * было видно и можно было растащить; при первом drag позиция сохранится.
 */
function tablesWithLayout(tables: Table[]): { table: Table; x: number; y: number }[] {
  const placed = tables.filter((t) => t.pos_x !== null && t.pos_y !== null)
  const unplaced = tables.filter((t) => t.pos_x === null || t.pos_y === null)
  const result = placed.map((t) => ({ table: t, x: t.pos_x!, y: t.pos_y! }))

  // Сетка для неразмещённых: 6 колонок, шаг ~15%, старт от 10%/12%
  const COLS = 6
  unplaced.forEach((t, i) => {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    result.push({ table: t, x: 10 + col * 15, y: 12 + row * 20 })
  })
  return result
}
