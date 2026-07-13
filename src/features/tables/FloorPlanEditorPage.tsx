import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import AppSidebar from '../../components/AppSidebar'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import {
  createTable,
  createTableZoneWithTables,
  deleteTable,
  deleteTableZone,
  fetchTables,
  fetchTableZones,
  renameTableZone,
  reorderTableZones,
  setTableLayout,
  updateTable,
} from './api'
import type { Table, TableShape, TableZone } from '../../types'
import { nextTableLabel } from './floorPlanUtils'

const UNASSIGNED = '__unassigned__'
const SIZES = [
  { key: 'sm', width: 8, height: 8 },
  { key: 'md', width: 11, height: 11 },
  { key: 'lg', width: 15, height: 15 },
] as const

type ResizeState = {
  id: string
  width: number
  height: number
  cx: number
  cy: number
  axis: 'both' | 'x' | 'y'
}

type TableDraft = {
  label: string
  zoneId: string
  seats: number
  combinable: boolean
}

/** Square-подобный конструктор: зоны → план → свойства выбранного стола. */
export default function FloorPlanEditorPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: zones = [], isLoading: zonesLoading } = useQuery({ queryKey: ['table_zones'], queryFn: fetchTableZones })
  const { data: tables = [], isLoading: tablesLoading } = useQuery({ queryKey: ['tables'], queryFn: fetchTables })

  const unassignedCount = tables.filter((tb) => !tb.zone_id).length
  const [requestedZoneId, setRequestedZoneId] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAddZone, setShowAddZone] = useState(false)
  const zoneSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
  )

  const requestedZoneIsValid = zones.some((zone) => zone.id === requestedZoneId)
    || (requestedZoneId === UNASSIGNED && unassignedCount > 0)
  const activeZoneId = requestedZoneIsValid
    ? requestedZoneId
    : zones[0]?.id ?? (unassignedCount > 0 ? UNASSIGNED : '')

  function selectZone(id: string) {
    setRequestedZoneId(id)
    setSelectedId(null)
  }

  const activeZone = zones.find((zone) => zone.id === activeZoneId)
  const visibleTables = useMemo(
    () => tables.filter((tb) => activeZoneId === UNASSIGNED ? !tb.zone_id : tb.zone_id === activeZoneId),
    [activeZoneId, tables],
  )
  const layout = useMemo(() => tablesWithLayout(visibleTables), [visibleTables])
  const selected = tables.find((tb) => tb.id === selectedId) ?? null

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const tableEls = useRef(new Map<string, HTMLButtonElement>())
  const dragRef = useRef<{ id: string; x: number; y: number; width: number; height: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [resize, setResize] = useState<ResizeState | null>(null)

  const layoutMut = useMutation({
    mutationFn: ({ id, x, y, width, height, shape }: { id: string; x: number; y: number; width?: number; height?: number; shape?: TableShape }) =>
      setTableLayout(id, x, y, width, shape, height),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: ['tables'] })
      const previous = qc.getQueryData<Table[]>(['tables'])
      qc.setQueryData<Table[]>(['tables'], (old = []) => old.map((tb) => tb.id === next.id ? {
        ...tb,
        pos_x: next.x,
        pos_y: next.y,
        width: next.width ?? tb.width,
        height: next.height ?? tb.height,
        shape: next.shape ?? tb.shape,
      } : tb))
      return { previous }
    },
    onError: (e, _next, ctx) => {
      if (ctx?.previous) qc.setQueryData(['tables'], ctx.previous)
      toast.error(e.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['tables'] }),
  })

  const tableSave = useMutation({
    mutationFn: async ({ table, draft }: { table: Table; draft: TableDraft }) => {
      const zone = zones.find((z) => z.id === draft.zoneId) ?? null
      await updateTable(table.id, draft.label.trim(), zone?.name ?? null, draft.seats, draft.combinable, zone?.id ?? null)
    },
    onMutate: async ({ table, draft }) => {
      await qc.cancelQueries({ queryKey: ['tables'] })
      const previous = qc.getQueryData<Table[]>(['tables'])
      const zone = zones.find((z) => z.id === draft.zoneId) ?? null
      qc.setQueryData<Table[]>(['tables'], (old = []) => old.map((tb) => tb.id === table.id ? {
        ...tb,
        label: draft.label.trim(),
        zone: zone?.name ?? null,
        zone_id: zone?.id ?? null,
        seats: draft.seats,
        combinable: draft.combinable,
      } : tb))
      return { previous }
    },
    onSuccess: () => toast.success(t(lang, 'saved')),
    onError: (e, _next, ctx) => {
      if (ctx?.previous) qc.setQueryData(['tables'], ctx.previous)
      toast.error(e.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['tables'] }),
  })

  const removeTable = useMutation({
    mutationFn: (id: string) => deleteTable(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['tables'] })
      const previous = qc.getQueryData<Table[]>(['tables'])
      qc.setQueryData<Table[]>(['tables'], (old = []) => old.filter((tb) => tb.id !== id))
      setSelectedId(null)
      return { previous }
    },
    onError: (e, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(['tables'], ctx.previous)
      toast.error(e.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['tables'] }),
  })

  const addTable = useMutation({
    mutationFn: async (zone: TableZone) => createTable(
      nextTableLabel(visibleTables),
      zone.name,
      tables.reduce((max, tb) => Math.max(max, tb.sort_order), 0) + 1,
      2,
      false,
      zone.id,
    ),
    onSuccess: (table) => {
      qc.setQueryData<Table[]>(['tables'], (old = []) => [...old, table])
      setSelectedId(table.id)
    },
    onError: (e) => toast.error(e.message),
  })

  const reorderZones = useMutation({
    mutationFn: (zoneIds: string[]) => reorderTableZones(zoneIds),
    onMutate: async (zoneIds) => {
      await qc.cancelQueries({ queryKey: ['table_zones'] })
      const previous = qc.getQueryData<TableZone[]>(['table_zones'])
      const byId = new Map((previous ?? []).map((zone) => [zone.id, zone]))
      qc.setQueryData<TableZone[]>(['table_zones'], zoneIds.map((id, index) => ({ ...byId.get(id)!, sort_order: index })))
      return { previous }
    },
    onError: (e, _ids, ctx) => {
      if (ctx?.previous) qc.setQueryData(['table_zones'], ctx.previous)
      toast.error(e.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['table_zones'] }),
  })

  function handleZoneDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = zones.findIndex((zone) => zone.id === active.id)
    const to = zones.findIndex((zone) => zone.id === over.id)
    if (from < 0 || to < 0) return
    reorderZones.mutate(arrayMove(zones, from, to).map((zone) => zone.id))
  }

  function startDrag(e: React.PointerEvent, tb: Table, x: number, y: number) {
    e.stopPropagation()
    setSelectedId(tb.id)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { id: tb.id, x, y, width: tb.width, height: tb.height }
    setDragId(tb.id)
  }

  function onPointerMove(e: React.PointerEvent) {
    if (resize) { onResizeMove(e); return }
    const drag = dragRef.current
    if (!drag || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const halfW = drag.width / 2
    const halfH = drag.height / 2
    const x = clamp(((e.clientX - rect.left) / rect.width) * 100, halfW, 100 - halfW)
    const y = clamp(((e.clientY - rect.top) / rect.height) * 100, halfH, 100 - halfH)
    dragRef.current = { ...drag, x, y }
    const el = tableEls.current.get(drag.id)
    if (el) { el.style.left = `${x}%`; el.style.top = `${y}%` }
  }

  function endPointer() {
    if (resize) { endResize(); return }
    const drag = dragRef.current
    if (drag) layoutMut.mutate({ id: drag.id, x: drag.x, y: drag.y })
    dragRef.current = null
    setDragId(null)
  }

  function startResize(e: React.PointerEvent, tb: Table, cx: number, cy: number, axis: ResizeState['axis']) {
    e.stopPropagation()
    setSelectedId(tb.id)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setResize({ id: tb.id, width: tb.width, height: tb.height, cx, cy, axis })
  }

  function onResizeMove(e: React.PointerEvent) {
    if (!resize || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * 100
    const py = ((e.clientY - rect.top) / rect.height) * 100
    setResize((current) => current ? {
      ...current,
      width: current.axis === 'y' ? current.width : clamp(Math.abs(px - current.cx) * 2, 5, 30),
      height: current.axis === 'x' ? current.height : clamp(Math.abs(py - current.cy) * 2, 5, 40),
    } : null)
  }

  function endResize() {
    if (!resize) return
    const table = tables.find((tb) => tb.id === resize.id)
    const item = layout.find((entry) => entry.table.id === resize.id)
    layoutMut.mutate({
      id: resize.id,
      x: table?.pos_x ?? item?.x ?? 50,
      y: table?.pos_y ?? item?.y ?? 50,
      width: resize.width,
      height: resize.height,
    })
    setResize(null)
  }

  const loading = zonesLoading || tablesLoading

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="settings" />

      <main className="flex-1 min-w-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <header className="h-20 shrink-0 px-6 border-b border-gray-100 flex items-center gap-4">
          <button onClick={() => navigate('/settings')} className="h-11 px-4 rounded-xl text-sm font-semibold text-gray-600 hover:bg-gray-100 active:scale-[0.97]">
            {t(lang, 'backToSettings')}
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-black text-gray-900">{t(lang, 'floorPlanTitle')}</h1>
            <p className="text-xs text-gray-500 mt-0.5">{t(lang, 'floorPlanAutosaveHint')}</p>
          </div>
          <button onClick={() => setShowAddZone(true)} className="btn-secondary !py-2.5 !px-4">
            {t(lang, 'addZone')}
          </button>
          <button
            onClick={() => activeZone && addTable.mutate(activeZone)}
            disabled={!activeZone || addTable.isPending}
            className="btn-secondary !py-2.5 !px-4"
          >
            {t(lang, 'addTable')}
          </button>
          <button onClick={() => navigate('/settings')} className="btn-primary !py-2.5 !px-5">
            {t(lang, 'done')}
          </button>
        </header>

        <div className="flex-1 min-h-0 flex">
          <aside className="w-60 shrink-0 border-e border-gray-100 p-4 overflow-y-auto">
            <div className="flex items-center justify-between px-2 mb-3">
              <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">{t(lang, 'zonesTitle')}</h2>
              <span className="text-xs font-semibold text-gray-400 tabular-nums">{zones.length}</span>
            </div>
            <div className="space-y-1">
              <DndContext sensors={zoneSensors} collisionDetection={closestCenter} onDragEnd={handleZoneDragEnd}>
                <SortableContext items={zones.map((zone) => zone.id)} strategy={verticalListSortingStrategy}>
                  {zones.map((zone) => (
                    <SortableZoneRow
                      key={zone.id}
                      zone={zone}
                      count={tables.filter((table) => table.zone_id === zone.id).length}
                      active={activeZoneId === zone.id}
                      onSelect={() => selectZone(zone.id)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              {unassignedCount > 0 && (
                <button
                  onClick={() => selectZone(UNASSIGNED)}
                  className={`w-full h-12 px-3 rounded-xl flex items-center gap-3 text-start transition-colors ${
                    activeZoneId === UNASSIGNED ? 'bg-gray-900 text-white' : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-gray-300" />
                  <span className="flex-1 min-w-0 text-sm font-bold truncate">{t(lang, 'unassignedZone')}</span>
                  <span className="text-xs tabular-nums text-gray-500">{unassignedCount}</span>
                </button>
              )}
            </div>
            {!loading && zones.length === 0 && (
              <div className="rounded-2xl bg-gray-50 p-4 text-center">
                <p className="text-sm font-bold text-gray-900">{t(lang, 'noZonesYet')}</p>
                <p className="text-xs text-gray-500 mt-1">{t(lang, 'noZonesHint')}</p>
                <button onClick={() => setShowAddZone(true)} className="btn-primary w-full !py-2.5 mt-4">
                  {t(lang, 'addZone')}
                </button>
              </div>
            )}
          </aside>

          <section className="flex-1 min-w-0 bg-gray-50 p-4 flex flex-col">
            <div className="h-10 flex items-center justify-between px-2 mb-2">
              <div>
                <span className="text-sm font-bold text-gray-900">{activeZone?.name ?? t(lang, 'unassignedZone')}</span>
                <span className="text-xs text-gray-500 ms-2">{visibleTables.length} {t(lang, 'tablesCountSuffix')}</span>
              </div>
              <span className="text-xs text-gray-500">{t(lang, 'floorPlanDragHint')}</span>
            </div>

            <div
              ref={canvasRef}
              onPointerMove={onPointerMove}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              onPointerDown={(e) => { if (e.target === e.currentTarget) setSelectedId(null) }}
              className="relative flex-1 min-h-0 rounded-2xl border border-gray-200 bg-white overflow-hidden touch-none"
              style={{
                backgroundImage: 'radial-gradient(circle, #d1d5db 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }}
            >
              {layout.map(({ table: tb, x, y }) => {
                const rz = resize?.id === tb.id ? resize : null
                const width = rz?.width ?? tb.width
                const height = rz?.height ?? tb.height
                const selectedNow = selectedId === tb.id
                const dragging = dragId === tb.id || !!rz
                return (
                  <button
                    key={tb.id}
                    ref={(el) => {
                      if (el) tableEls.current.set(tb.id, el)
                      else tableEls.current.delete(tb.id)
                    }}
                    onPointerDown={(e) => startDrag(e, tb, x, y)}
                    style={{
                      left: `${x}%`,
                      top: `${y}%`,
                      width: `${width}%`,
                      height: `${height}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                    className={`absolute min-w-[48px] min-h-[48px] border-2 bg-white flex items-center justify-center select-none touch-none text-gray-900 ${
                      tb.shape === 'circle' ? 'rounded-full' : 'rounded-xl'
                    } ${selectedNow ? 'border-gray-900 shadow-lg z-10' : 'border-gray-300 hover:border-gray-500'} ${
                      dragging ? '' : 'transition-shadow'
                    }`}
                  >
                    <span className="text-lg font-black tabular-nums truncate px-2">{tb.label}</span>
                    {selectedNow && (
                      <>
                        <span
                          onPointerDown={(e) => startResize(e, tb, x, y, 'x')}
                          className="absolute top-1/2 -end-2 -translate-y-1/2 w-4 h-8 rounded-full bg-white border-2 border-gray-900 z-20"
                        />
                        <span
                          onPointerDown={(e) => startResize(e, tb, x, y, 'y')}
                          className="absolute -bottom-2 start-1/2 -translate-x-1/2 w-8 h-4 rounded-full bg-white border-2 border-gray-900 z-20"
                        />
                        <span
                          onPointerDown={(e) => startResize(e, tb, x, y, 'both')}
                          className="absolute -bottom-2 -end-2 w-5 h-5 rounded-full bg-white border-2 border-gray-900 z-20"
                        />
                      </>
                    )}
                  </button>
                )
              })}

              {!loading && activeZoneId && visibleTables.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center max-w-xs">
                    <p className="font-bold text-gray-900">{t(lang, 'zoneEmpty')}</p>
                    <p className="text-sm text-gray-500 mt-1">{t(lang, 'zoneEmptyHint')}</p>
                    {activeZone && (
                      <button onClick={() => addTable.mutate(activeZone)} className="btn-primary !py-2.5 !px-5 mt-4">
                        {t(lang, 'addTable')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>

          <aside className="w-80 shrink-0 border-s border-gray-100 p-5 overflow-y-auto">
            {selected ? (
              <TableInspector
                key={selected.id}
                table={selected}
                zones={zones}
                busy={tableSave.isPending || removeTable.isPending}
                onSave={(draft) => tableSave.mutate({ table: selected, draft })}
                onLayoutChange={(next) => {
                  const item = layout.find((entry) => entry.table.id === selected.id)
                  layoutMut.mutate({
                    id: selected.id,
                    x: selected.pos_x ?? item?.x ?? 50,
                    y: selected.pos_y ?? item?.y ?? 50,
                    ...next,
                  })
                }}
                onDelete={() => {
                  if (confirm(t(lang, 'confirmDeleteTable'))) removeTable.mutate(selected.id)
                }}
              />
            ) : activeZone ? (
              <ZoneInspector
                key={activeZone.id}
                zone={activeZone}
                tableCount={visibleTables.length}
                onDeleted={() => selectZone('')}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-center">
                <div>
                  <p className="font-bold text-gray-900">{t(lang, 'selectZone')}</p>
                  <p className="text-sm text-gray-500 mt-1">{t(lang, 'selectZoneHint')}</p>
                </div>
              </div>
            )}
          </aside>
        </div>
      </main>

      {showAddZone && (
        <AddZoneDialog
          nextSortOrder={zones.reduce((max, zone) => Math.max(max, zone.sort_order), -1) + 1}
          tableSortOrder={tables.reduce((max, table) => Math.max(max, table.sort_order), 0) + 1}
          onCreated={(zone) => { selectZone(zone.id); setShowAddZone(false) }}
          onClose={() => setShowAddZone(false)}
        />
      )}
    </div>
  )
}

function SortableZoneRow({
  zone, count, active, onSelect,
}: {
  zone: TableZone
  count: number
  active: boolean
  onSelect: () => void
}) {
  const lang = useLangStore((s) => s.lang)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: zone.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`w-full h-12 rounded-xl flex items-center overflow-hidden transition-colors ${
        active ? 'bg-gray-900 text-white' : 'text-gray-700 hover:bg-gray-100'
      } ${isDragging ? 'shadow-lg ring-1 ring-gray-200' : ''}`}
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={t(lang, 'reorder')}
        className={`w-11 h-12 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none ${
          active ? 'text-gray-400' : 'text-gray-300 hover:text-gray-500'
        }`}
      >
        <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="5" cy="4" r="1.3" /><circle cx="11" cy="4" r="1.3" />
          <circle cx="5" cy="8" r="1.3" /><circle cx="11" cy="8" r="1.3" />
          <circle cx="5" cy="12" r="1.3" /><circle cx="11" cy="12" r="1.3" />
        </svg>
      </button>
      <button onClick={onSelect} className="h-12 flex-1 min-w-0 pe-3 flex items-center gap-3 text-start">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${active ? 'bg-white' : 'bg-gray-300'}`} />
        <span className="flex-1 min-w-0 text-sm font-bold truncate">{zone.name}</span>
        <span className={`text-xs tabular-nums ${active ? 'text-gray-300' : 'text-gray-500'}`}>{count}</span>
      </button>
    </div>
  )
}

function TableInspector({
  table, zones, busy, onSave, onLayoutChange, onDelete,
}: {
  table: Table
  zones: TableZone[]
  busy: boolean
  onSave: (draft: TableDraft) => void
  onLayoutChange: (next: { width?: number; height?: number; shape?: TableShape }) => void
  onDelete: () => void
}) {
  const lang = useLangStore((s) => s.lang)
  const [draft, setDraft] = useState<TableDraft>({
    label: table.label,
    zoneId: table.zone_id ?? '',
    seats: table.seats ?? 2,
    combinable: table.combinable ?? false,
  })

  const size = nearestSize(table.width, table.height)

  return (
    <div>
      <h2 className="text-lg font-black text-gray-900">{t(lang, 'tableSettingsTitle')}</h2>
      <p className="text-xs text-gray-500 mt-1 mb-5">{t(lang, 'tableSettingsHint')}</p>

      <Field label={t(lang, 'tableLabelField')}>
        <input className="input" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
      </Field>

      <Field label={t(lang, 'zoneField')}>
        <select className="input" value={draft.zoneId} onChange={(e) => setDraft({ ...draft, zoneId: e.target.value })}>
          <option value="">{t(lang, 'unassignedZone')}</option>
          {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
        </select>
      </Field>

      <Field label={t(lang, 'tableSeatsField')}>
        <div className="flex items-center gap-3">
          <button onClick={() => setDraft({ ...draft, seats: Math.max(1, draft.seats - 1) })} className="h-11 w-11 rounded-xl bg-gray-100 text-xl font-bold">−</button>
          <span className="flex-1 text-center text-xl font-black tabular-nums">{draft.seats}</span>
          <button onClick={() => setDraft({ ...draft, seats: Math.min(100, draft.seats + 1) })} className="h-11 w-11 rounded-xl bg-gray-100 text-xl font-bold">+</button>
        </div>
      </Field>

      <Field label={t(lang, 'tableShape')}>
        <Segment
          value={table.shape}
          options={[
            { value: 'square', label: t(lang, 'shapeSquare') },
            { value: 'circle', label: t(lang, 'shapeCircle') },
          ]}
          onChange={(shape) => onLayoutChange({ shape })}
        />
      </Field>

      <Field label={t(lang, 'tableSize')}>
        <Segment
          value={size}
          options={SIZES.map((item) => ({ value: item.key, label: t(lang, item.key === 'sm' ? 'sizeSm' : item.key === 'md' ? 'sizeMd' : 'sizeLg') }))}
          onChange={(key) => {
            const next = SIZES.find((item) => item.key === key)!
            onLayoutChange({ width: next.width, height: next.height })
          }}
        />
      </Field>

      <button
        type="button"
        onClick={() => setDraft({ ...draft, combinable: !draft.combinable })}
        className="w-full min-h-[52px] flex items-center justify-between gap-3 text-start mb-5"
      >
        <span>
          <span className="block text-sm font-semibold text-gray-900">{t(lang, 'tableCombinable')}</span>
          <span className="block text-xs text-gray-500 mt-0.5">{t(lang, 'tableCombinableHint')}</span>
        </span>
        <span className={`shrink-0 h-7 w-12 rounded-full relative transition-colors ${draft.combinable ? 'bg-gray-900' : 'bg-gray-200'}`}>
          <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${draft.combinable ? 'start-6' : 'start-1'}`} />
        </span>
      </button>

      <button onClick={() => onSave(draft)} disabled={busy || !draft.label.trim()} className="btn-primary w-full !py-3">
        {t(lang, 'save')}
      </button>
      <button onClick={onDelete} disabled={busy} className="btn-danger w-full !py-3 mt-2">
        {t(lang, 'deleteTableAction')}
      </button>
    </div>
  )
}

function ZoneInspector({ zone, tableCount, onDeleted }: { zone: TableZone; tableCount: number; onDeleted: () => void }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const [name, setName] = useState(zone.name)

  const rename = useMutation({
    mutationFn: () => renameTableZone(zone, name),
    onMutate: async () => {
      await Promise.all([
        qc.cancelQueries({ queryKey: ['table_zones'] }),
        qc.cancelQueries({ queryKey: ['tables'] }),
      ])
      const previousZones = qc.getQueryData<TableZone[]>(['table_zones'])
      const previousTables = qc.getQueryData<Table[]>(['tables'])
      qc.setQueryData<TableZone[]>(['table_zones'], (old = []) => old.map((item) => item.id === zone.id ? { ...item, name: name.trim() } : item))
      qc.setQueryData<Table[]>(['tables'], (old = []) => old.map((table) => table.zone_id === zone.id ? { ...table, zone: name.trim() } : table))
      return { previousZones, previousTables }
    },
    onSuccess: () => toast.success(t(lang, 'saved')),
    onError: (e, _v, ctx) => {
      if (ctx?.previousZones) qc.setQueryData(['table_zones'], ctx.previousZones)
      if (ctx?.previousTables) qc.setQueryData(['tables'], ctx.previousTables)
      toast.error(e.message)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['table_zones'] })
      qc.invalidateQueries({ queryKey: ['tables'] })
    },
  })

  const remove = useMutation({
    mutationFn: () => deleteTableZone(zone.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['table_zones'] })
      qc.invalidateQueries({ queryKey: ['tables'] })
      onDeleted()
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div>
      <h2 className="text-lg font-black text-gray-900">{t(lang, 'zoneSettingsTitle')}</h2>
      <p className="text-xs text-gray-500 mt-1 mb-5">{tableCount} {t(lang, 'tablesCountSuffix')}</p>
      <Field label={t(lang, 'zoneNameField')}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <button onClick={() => rename.mutate()} disabled={rename.isPending || !name.trim() || name.trim() === zone.name} className="btn-primary w-full !py-3">
        {t(lang, 'save')}
      </button>
      <button
        onClick={() => { if (confirm(t(lang, 'confirmDeleteZone'))) remove.mutate() }}
        disabled={remove.isPending}
        className="btn-danger w-full !py-3 mt-2"
      >
        {t(lang, 'deleteZone')}
      </button>
      <p className="text-xs text-gray-500 mt-3">{t(lang, 'deleteZoneHint')}</p>
    </div>
  )
}

function AddZoneDialog({
  nextSortOrder, tableSortOrder, onCreated, onClose,
}: {
  nextSortOrder: number
  tableSortOrder: number
  onCreated: (zone: TableZone) => void
  onClose: () => void
}) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const qc = useQueryClient()
  const zoneId = useRef(crypto.randomUUID()).current
  const [name, setName] = useState('')
  const [count, setCount] = useState(6)
  const [prefix, setPrefix] = useState('')

  const create = useMutation({
    mutationFn: async () => {
      return createTableZoneWithTables(zoneId, name, nextSortOrder, count, prefix, tableSortOrder)
    },
    onSuccess: (zone) => {
      qc.invalidateQueries({ queryKey: ['table_zones'] })
      qc.invalidateQueries({ queryKey: ['tables'] })
      onCreated(zone)
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-black text-gray-900">{t(lang, 'newZoneTitle')}</h2>
        <p className="text-sm text-gray-500 mt-1 mb-5">{t(lang, 'newZoneHint')}</p>

        <Field label={t(lang, 'zoneNameField')}>
          <input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t(lang, 'zoneNamePlaceholder')} />
        </Field>

        <Field label={t(lang, 'numberOfTables')}>
          <div className="flex items-center gap-3">
            <button onClick={() => setCount((n) => Math.max(1, n - 1))} className="h-11 w-11 rounded-xl bg-gray-100 text-xl font-bold">−</button>
            <span className="flex-1 text-center text-xl font-black tabular-nums">{count}</span>
            <button onClick={() => setCount((n) => Math.min(50, n + 1))} className="h-11 w-11 rounded-xl bg-gray-100 text-xl font-bold">+</button>
          </div>
        </Field>

        <Field label={t(lang, 'tablePrefixField')}>
          <input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder={t(lang, 'tablePrefixPlaceholder')} />
          <p className="text-xs text-gray-500 mt-2">{t(lang, 'tablePrefixPreview')}: {prefix.trim()}1, {prefix.trim()}2, {prefix.trim()}3…</p>
        </Field>

        <div className="flex gap-2 mt-6">
          <button onClick={onClose} className="btn-secondary flex-1 !py-3">{t(lang, 'cancel')}</button>
          <button onClick={() => create.mutate()} disabled={create.isPending || !name.trim()} className="btn-primary flex-1 !py-3">
            {t(lang, 'createZone')}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-4">
      <span className="block text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">{label}</span>
      {children}
    </label>
  )
}

function Segment<T extends string>({
  options, value, onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className={`grid gap-1 rounded-xl border border-gray-100 bg-gray-50 p-1 ${options.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`h-11 rounded-lg text-sm font-semibold transition-all ${
            option.value === value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function nearestSize(width: number, height: number): (typeof SIZES)[number]['key'] {
  return SIZES.reduce((best, item) => {
    const distance = Math.abs(item.width - width) + Math.abs(item.height - height)
    const bestDistance = Math.abs(best.width - width) + Math.abs(best.height - height)
    return distance < bestDistance ? item : best
  }, SIZES[1]).key
}

function tablesWithLayout(tables: Table[]): { table: Table; x: number; y: number }[] {
  const placed = tables.filter((table) => table.pos_x !== null && table.pos_y !== null)
  const unplaced = tables.filter((table) => table.pos_x === null || table.pos_y === null)
  const result = placed.map((table) => ({ table, x: table.pos_x!, y: table.pos_y! }))
  const columns = 5
  unplaced.forEach((table, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    result.push({ table, x: 12 + col * 19, y: 15 + row * 22 })
  })
  return result
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
