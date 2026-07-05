import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchTables, createTable, updateTable, deleteTable } from './api'
import { useTablesRealtime } from './useTablesRealtime'
import TableCard from './TableCard'
import { useAuthStore } from '../../store/authStore'
import { useOrderStore } from '../../store/orderStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import LangToggle from '../../components/ui/LangToggle'
import HubButton from '../../components/ui/HubButton'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import toast from 'react-hot-toast'
import type { Table } from '../../types'

const ZONES_RU = ['Все', 'Зал A', 'Зал B', 'Терраса', 'Бар']
const ZONES_HE = ['הכל', 'אולם A', 'אולם B', 'טרסה', 'בר']

function TableManagementDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [editTable, setEditTable] = useState<Table | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ number: '', capacity: '4', zone: '' })
  const [confirmDelete, setConfirmDelete] = useState<Table | null>(null)

  const { data: tables = [] } = useQuery({ queryKey: ['all-tables'], queryFn: fetchTables })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['all-tables'] })
    qc.invalidateQueries({ queryKey: ['tables'] })
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const number = parseInt(form.number)
      const capacity = parseInt(form.capacity) || 4
      const zone = form.zone.trim() || null
      if (editTable) return updateTable(editTable.id, { number, capacity, zone })
      return createTable(number, capacity, zone)
    },
    onSuccess: () => {
      invalidate()
      setShowForm(false)
      setEditTable(null)
      setForm({ number: '', capacity: '4', zone: '' })
      toast.success(editTable ? 'Стол обновлён' : 'Стол добавлен')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTable(id),
    onSuccess: () => { invalidate(); toast.success('Стол удалён') },
    onError: (e: Error) => toast.error(e.message),
  })

  const openCreate = () => {
    setEditTable(null)
    const next = tables.length > 0 ? Math.max(...tables.map((t) => t.number)) + 1 : 1
    setForm({ number: String(next), capacity: '4', zone: '' })
    setShowForm(true)
  }

  const openEdit = (t: Table) => {
    setEditTable(t)
    setForm({ number: String(t.number), capacity: String(t.capacity), zone: t.zone ?? '' })
    setShowForm(true)
  }

  const zones = [...new Set(tables.map((t) => t.zone).filter(Boolean))] as string[]

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/20 z-20 backdrop-blur-[1px]" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed top-0 right-0 h-full w-[360px] bg-white shadow-2xl z-30 flex flex-col">
        <div className="h-14 px-5 flex items-center justify-between border-b border-gray-100 shrink-0">
          <span className="font-bold text-gray-900 text-sm">Управление столами</span>
          <div className="flex items-center gap-2">
            <button onClick={openCreate} className="btn-primary text-xs px-3 py-1.5">+ Стол</button>
            <button onClick={onClose} className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-400 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {showForm && (
            <div className="card p-4 border border-gray-200">
              <p className="font-bold text-gray-900 text-sm mb-3">
                {editTable ? `Стол №${editTable.number}` : 'Новый стол'}
              </p>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Номер</label>
                  <input autoFocus type="number" min="1" value={form.number}
                    onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))}
                    className="input text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Мест</label>
                  <input type="number" min="1" max="20" value={form.capacity}
                    onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
                    className="input text-sm" />
                </div>
                <div className="col-span-2">
                  <label className="text-xs text-gray-400 mb-1 block">Зона</label>
                  <input type="text" value={form.zone} list="drawer-zones"
                    placeholder={zones[0] ?? 'Терраса, Зал, Бар...'}
                    onChange={(e) => setForm((f) => ({ ...f, zone: e.target.value }))}
                    className="input text-sm" />
                  <datalist id="drawer-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => saveMutation.mutate()} disabled={!form.number || saveMutation.isPending}
                  className="btn-success flex-1 text-sm py-2">
                  {saveMutation.isPending ? 'Сохраняем...' : 'Сохранить'}
                </button>
                <button onClick={() => { setShowForm(false); setEditTable(null) }}
                  className="btn-secondary px-4 text-sm py-2">Отмена</button>
              </div>
            </div>
          )}

          <div className="card overflow-hidden">
            {tables.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400">Нет столов</div>
            ) : (
              <>
                <div className="px-4 py-2 border-b border-gray-100 grid grid-cols-[40px_1fr_40px_56px] gap-3">
                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">№</span>
                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Зона</span>
                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide text-center">Мест</span>
                  <span />
                </div>
                {tables.map((tbl, i) => (
                  <div key={tbl.id} className={`px-4 py-3 grid grid-cols-[40px_1fr_40px_56px] gap-3 items-center ${i !== tables.length - 1 ? 'border-b border-gray-50' : ''}`}>
                    <span className="text-sm font-bold text-gray-900">{tbl.number}</span>
                    <span className="text-sm text-gray-500 truncate">{tbl.zone ?? <span className="text-gray-300">—</span>}</span>
                    <span className="text-sm text-gray-600 text-center">{tbl.capacity}</span>
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => openEdit(tbl)}
                        className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-300 hover:text-gray-700 transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      <button onClick={() => setConfirmDelete(tbl)}
                        className="w-7 h-7 rounded-lg hover:bg-red-50 flex items-center justify-center text-gray-300 hover:text-red-500 transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={`Удалить стол №${confirmDelete.number}?`}
          message="Это действие нельзя отменить"
          confirmLabel="Удалить"
          cancelLabel="Отмена"
          onConfirm={() => { deleteMutation.mutate(confirmDelete.id); setConfirmDelete(null) }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  )
}

export default function TablesPage() {
  const navigate = useNavigate()
  const staff = useAuthStore((s) => s.currentStaff)
  const logout = useAuthStore((s) => s.logout)
  const setActiveTable = useOrderStore((s) => s.setActiveTable)
  const clearCart = useOrderStore((s) => s.clearCart)
  const lang = useLangStore((s) => s.lang)

  const zones = lang === 'he' ? ZONES_HE : ZONES_RU
  const [activeZone, setActiveZone] = useState(zones[0])
  const [showManage, setShowManage] = useState(false)

  const { data: tables = [], isLoading } = useQuery({
    queryKey: ['tables'],
    queryFn: fetchTables,
    staleTime: 0,
  })

  useTablesRealtime()

  const filtered = activeZone === zones[0]
    ? tables
    : tables.filter((tbl) => {
        if (lang === 'he') {
          const idx = ZONES_HE.indexOf(activeZone)
          return tbl.zone === ZONES_RU[idx]
        }
        return tbl.zone === activeZone
      })

  const stats = {
    free:     tables.filter((t) => t.status === 'free').length,
    occupied: tables.filter((t) => t.status === 'occupied').length,
    waiting:  tables.filter((t) => t.status === 'waiting_bill').length,
  }

  const handleTableClick = (table: Table) => {
    clearCart()
    setActiveTable(table.id)
    navigate(`/order/${table.id}`)
  }

  const isRtl = lang === 'he'

  return (
    <div className="min-h-screen bg-[#f8f9fb]" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Header */}
      <header className="bg-white border-b border-gray-100 px-6 h-14 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <HubButton />
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-gray-900 rounded-lg flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <span className="font-bold text-gray-900 text-base">{t(lang, 'appName')}</span>
          </div>

          {/* Stats */}
          <div className="hidden sm:flex items-center gap-1.5">
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 rounded-xl">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              <span className="text-xs font-semibold text-gray-600">{stats.free}</span>
              <span className="text-xs text-gray-400">{t(lang, 'freeLabel')}</span>
            </div>
            {stats.occupied > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 rounded-xl">
                <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                <span className="text-xs font-semibold text-amber-700">{stats.occupied}</span>
                <span className="text-xs text-amber-500">{t(lang, 'occupiedLabel')}</span>
              </div>
            )}
            {stats.waiting > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 rounded-xl animate-pulse">
                <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                <span className="text-xs font-bold text-red-600">{stats.waiting}</span>
                <span className="text-xs text-red-400">{t(lang, 'billLabel')}</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <LangToggle />
          <div className="flex items-center gap-2 pl-3 border-l border-gray-100">
            <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center">
              <span className="text-xs font-bold text-gray-600">
                {staff?.name?.charAt(0)?.toUpperCase()}
              </span>
            </div>
            <span className="text-sm text-gray-700 font-medium">{staff?.name}</span>
          </div>
          <button
            onClick={logout}
            className="btn-ghost text-xs py-1.5 px-3"
          >
            {t(lang, 'logout')}
          </button>
        </div>
      </header>

      {/* Zone tabs + summary */}
      <div className="px-6 pt-5 pb-4 flex items-center gap-3 justify-between">
        <div className="flex gap-1.5 overflow-x-auto">
          {zones.map((zone) => (
            <button
              key={zone}
              onClick={() => setActiveZone(zone)}
              className={`
                px-4 py-1.5 rounded-xl text-sm font-medium whitespace-nowrap
                transition-all duration-150
                ${activeZone === zone
                  ? 'bg-gray-900 text-white shadow-sm'
                  : 'bg-white text-gray-500 border border-gray-200 hover:text-gray-800 hover:border-gray-300'
                }
              `}
            >
              {zone}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400 shrink-0">
          {filtered.length} {lang === 'he' ? 'שולחנות' : 'столов'}
        </span>
      </div>

      {showManage && <TableManagementDrawer onClose={() => setShowManage(false)} />}

      {staff?.role === 'manager' && (
        <button
          onClick={() => setShowManage(true)}
          className="fixed bottom-6 right-6 w-12 h-12 bg-gray-900 hover:bg-gray-700 text-white rounded-2xl shadow-lg flex items-center justify-center transition-all duration-150 active:scale-[0.93] z-10"
          title="Управление столами"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28zM15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      )}

      {/* Grid */}
      <main className="px-6 pb-8">
        {isLoading ? (
          <div className="grid grid-cols-4 gap-3 lg:grid-cols-6 xl:grid-cols-8">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-[130px] rounded-2xl bg-gray-100 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-3 lg:grid-cols-6 xl:grid-cols-8">
            {filtered.map((table) => (
              <TableCard
                key={table.id}
                table={table}
                lang={lang}
                onClick={() => handleTableClick(table)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
