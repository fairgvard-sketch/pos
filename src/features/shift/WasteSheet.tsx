import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchItems } from '../menu/api'
import { addWaste, fetchTodayWaste } from './api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t, formatTime } from '../../lib/i18n'

/**
 * Списание дня (047) — ритуал закрытия пекарни: отметить, сколько
 * выбросили. Степперы по товарам → add_waste пишет строки (только
 * INSERT, аудит) и уменьшает остатки учитываемых товаров.
 */
export default function WasteSheet({ onClose }: { onClose: () => void }) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const { data: items = [] } = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })
  const { data: today = [] } = useQuery({ queryKey: ['waste_today'], queryFn: fetchTodayWaste })

  const [search, setSearch] = useState('')
  const [qtyById, setQtyById] = useState<Record<string, number>>({})
  const [reason, setReason] = useState('')

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items
    return list.slice(0, 50)
  }, [items, search])

  const totalQty = Object.values(qtyById).reduce((s, n) => s + n, 0)

  function bump(id: string, delta: number) {
    setQtyById((prev) => {
      const next = { ...prev, [id]: Math.max((prev[id] ?? 0) + delta, 0) }
      if (next[id] === 0) delete next[id]
      return next
    })
  }

  const save = useMutation({
    mutationFn: () =>
      addWaste(
        staff!.id,
        Object.entries(qtyById).map(([menu_item_id, qty]) => ({
          menu_item_id,
          qty,
          reason: reason.trim() || null,
        }))
      ),
    onSuccess: () => {
      setQtyById({})
      setReason('')
      qc.invalidateQueries({ queryKey: ['waste_today'] })
      qc.invalidateQueries({ queryKey: ['menu_items'] }) // остатки изменились
      toast.success(t(lang, 'wasteDone'))
    },
    onError: (e) => toast.error(e.message),
  })

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
          <h2 className="flex-1 text-lg font-black text-gray-900">{t(lang, 'wasteTitle')}</h2>
          <button
            onClick={onClose}
            aria-label={t(lang, 'close')}
            className="w-11 h-11 rounded-xl hover:bg-gray-100 active:scale-[0.97] flex items-center justify-center text-xl text-gray-500"
          >
            ✕
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">{t(lang, 'wasteEmptyHint')}</p>

        <input
          className="input !py-2.5 mb-3"
          placeholder={t(lang, 'searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="mb-4 max-h-[38vh] overflow-y-auto">
          {visible.map((i) => {
            const qty = qtyById[i.id] ?? 0
            return (
              <div key={i.id} className="flex items-center gap-2 min-h-[48px] px-1 border-b border-gray-100">
                <span className={`flex-1 min-w-0 truncate text-sm ${qty > 0 ? 'font-bold text-gray-900' : 'text-gray-900'}`}>
                  {i.name}
                  {i.track_inventory && i.stock != null && (
                    <span className="font-normal text-gray-400 tabular-nums"> · {i.stock}</span>
                  )}
                </span>
                <button
                  onClick={() => bump(i.id, -1)}
                  disabled={qty === 0}
                  className="w-11 h-11 rounded-xl border border-gray-200 font-bold text-gray-900 disabled:opacity-30 active:scale-[0.94]"
                >
                  −
                </button>
                <span className="w-8 text-center font-bold tabular-nums text-gray-900">{qty || ''}</span>
                <button
                  onClick={() => bump(i.id, 1)}
                  className="w-11 h-11 rounded-xl border border-gray-200 font-bold text-gray-900 active:scale-[0.94]"
                >
                  +
                </button>
              </div>
            )
          })}
        </div>

        {totalQty > 0 && (
          <input
            className="input !py-2.5 mb-3"
            placeholder={t(lang, 'wasteReasonPh')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}

        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || totalQty === 0 || !staff}
          className="btn-primary w-full !py-3.5 !rounded-2xl disabled:opacity-40"
        >
          {t(lang, 'wasteAddBtn')}{totalQty > 0 ? ` · ${totalQty}` : ''}
        </button>

        {today.length > 0 && (
          <div className="mt-5">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
              {t(lang, 'wasteTodayTitle')}
            </div>
            {today.map((w) => (
              <div key={w.id} className="flex items-center gap-3 min-h-[44px] px-1 border-b border-gray-100 text-sm">
                <span className="flex-1 min-w-0 truncate text-gray-900">
                  {w.qty}× {w.name}
                  {w.reason && <span className="text-gray-400"> · {w.reason}</span>}
                </span>
                <span className="shrink-0 text-xs text-gray-500 tabular-nums">
                  {formatTime(w.created_at, lang)}
                  {w.staff?.name && ` · ${w.staff.name}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
