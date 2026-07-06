import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchTables, fetchOpenTableOrders, openTableOrder } from './api'
import { fetchCurrentLocation } from '../auth/api'
import { fetchCurrentShift } from '../shift/api'
import { useCartStore } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase'
import AppSidebar from '../../components/AppSidebar'
import ShiftGate from '../shift/ShiftGate'

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

  // Realtime: любой заказ меняется → перечитать занятость
  useEffect(() => {
    const ch = supabase
      .channel('hall')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () =>
        qc.invalidateQueries({ queryKey: ['open_table_orders'] })
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

  async function openTable(tableId: string, tableLabel: string) {
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
        <h1 className="text-2xl font-black text-gray-900 mb-6">{t(lang, 'hall')}</h1>

        {!modeOk ? (
          <p className="text-gray-400 text-sm">{t(lang, 'serviceModeHint')}</p>
        ) : tables.length === 0 ? (
          <div className="text-center pt-24">
            <p className="font-bold text-gray-900">{t(lang, 'hallEmpty')}</p>
            <p className="text-sm text-gray-500 mt-1">{t(lang, 'hallEmptyHint')}</p>
          </div>
        ) : (
          <div className="space-y-8">
            {zones.map(([zone, zTables]) => (
              <section key={zone}>
                {zone && <h2 className="text-sm font-bold text-gray-500 mb-3">{zone}</h2>}
                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                  {zTables.map((tb) => {
                    const occ = occupancyByTable.get(tb.id)
                    const busy = !!occ
                    return (
                      <button
                        key={tb.id}
                        onClick={() => openTable(tb.id, tb.label)}
                        className={`aspect-square rounded-2xl border p-3 flex flex-col items-center justify-center gap-1 transition-all active:scale-[0.97] ${
                          busy
                            ? 'border-gray-900 bg-gray-900 text-white'
                            : 'border-gray-200 hover:border-gray-400 text-gray-900'
                        }`}
                      >
                        <span className="text-2xl font-black tabular-nums leading-none">{tb.label}</span>
                        {busy ? (
                          <span className="text-xs font-bold tabular-nums mt-1">{formatMoney(occ!.total, lang)}</span>
                        ) : (
                          <span className="text-[11px] text-gray-400">{t(lang, 'tableFree')}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
