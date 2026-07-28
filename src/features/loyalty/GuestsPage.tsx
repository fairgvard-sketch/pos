import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../../store/langStore'
import { t, formatDate } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import { fetchCurrentLocation } from '../auth/api'
import AppSidebar from '../../components/AppSidebar'
import {
  searchGuests, fetchGuestOrders, renameGuest, formatPhone, type Guest,
} from './api'

/**
 * Раздел «Гости» (113): список гостей лояльности с балансом и историей
 * покупок. Балансы меняет только сервер (apply_loyalty/pay_order) —
 * здесь они read-only; правится лишь имя гостя.
 */
export default function GuestsPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'

  const [search, setSearch] = useState('')
  const [searchQ, setSearchQ] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setSearchQ(search), 300)
    return () => clearTimeout(id)
  }, [search])

  const [selected, setSelected] = useState<Guest | null>(null)

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const { data: guests = [], isFetching } = useQuery({
    queryKey: ['guests', searchQ],
    queryFn: () => searchGuests(searchQ),
    placeholderData: (prev) => prev,
  })

  const mode = location?.loyalty_mode ?? 'off'
  const stampsGoal = location?.loyalty_stamps_goal ?? 0

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="settings" />

      <main className="flex-1 min-w-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100 shrink-0">
          <h1 className="text-xl font-bold text-gray-900">{t(lang, 'guestsTitle')}</h1>
          <input
            className="input flex-1 max-w-xs"
            placeholder={t(lang, 'guestSearchPh')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {mode === 'off' && (
          <p className="text-sm text-amber-700 bg-amber-50 px-6 py-3 shrink-0">
            {t(lang, 'guestsLoyaltyOffHint')}
          </p>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          {guests.length === 0 ? (
            <p className="text-sm text-gray-500 text-center pt-12">
              {isFetching ? t(lang, 'loading') : t(lang, 'guestNotFound')}
            </p>
          ) : (
            <div className="space-y-2 max-w-3xl">
              {guests.map((g) => (
                <button
                  key={g.id}
                  onClick={() => setSelected(g)}
                  className="card w-full p-4 flex items-center gap-3 text-start hover:border-gray-400 transition-all active:scale-[0.99]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-gray-900 text-sm truncate">
                      {g.name || formatPhone(g.phone)}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 tabular-nums" dir="ltr">
                      {formatPhone(g.phone)}
                    </div>
                  </div>
                  <div className="text-end shrink-0">
                    <div className="text-sm font-bold text-gray-900 tabular-nums">
                      {mode === 'stamps'
                        ? `${g.stamps}/${stampsGoal} ${t(lang, 'stampsShort')}`
                        : formatMoney(g.points, lang)}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 tabular-nums">
                      {t(lang, 'guestVisits')}: {g.visits} · {formatMoney(g.total_spent, lang)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>

      {selected && (
        <GuestDetailSheet
          guest={selected}
          lang={lang}
          mode={mode}
          stampsGoal={stampsGoal}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

/** Карточка гостя: баланс, итоги и последние заказы; правится только имя */
function GuestDetailSheet({
  guest, lang, mode, stampsGoal, onClose,
}: {
  guest: Guest
  lang: 'ru' | 'he'
  mode: 'off' | 'stamps' | 'points'
  stampsGoal: number
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(guest.name ?? '')

  const { data: orders = [], isFetching } = useQuery({
    queryKey: ['guest_orders', guest.id],
    queryFn: () => fetchGuestOrders(guest.id),
  })

  const rename = useMutation({
    mutationFn: () => renameGuest(guest.id, name),
    onSuccess: () => {
      toast.success(t(lang, 'saved'))
      qc.invalidateQueries({ queryKey: ['guests'] })
    },
    onError: (e) => toast.error((e as Error).message),
  })

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div
        className="card w-full max-w-md p-6 max-h-[92vh] overflow-y-auto animate-[rise-in_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-black text-gray-900">{guest.name || formatPhone(guest.phone)}</h2>
        <p className="text-sm text-gray-500 tabular-nums mt-0.5" dir="ltr">{formatPhone(guest.phone)}</p>

        <div className="grid grid-cols-3 gap-2 mt-4">
          <Stat
            label={mode === 'stamps' ? t(lang, 'stampsBalance') : t(lang, 'pointsBalance')}
            value={mode === 'stamps' ? `${guest.stamps}/${stampsGoal}` : formatMoney(guest.points, lang)}
          />
          <Stat label={t(lang, 'guestVisits')} value={String(guest.visits)} />
          <Stat label={t(lang, 'guestSpent')} value={formatMoney(guest.total_spent, lang)} />
        </div>

        <label className="block mt-4">
          <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">
            {t(lang, 'guestNamePh')}
          </span>
          <div className="flex gap-2">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            <button
              className="btn-secondary shrink-0 !px-4"
              disabled={rename.isPending || name.trim() === (guest.name ?? '').trim()}
              onClick={() => rename.mutate()}
            >
              {t(lang, 'save')}
            </button>
          </div>
        </label>

        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mt-6 mb-2">
          {t(lang, 'guestLastOrders')}
        </h3>
        {orders.length === 0 ? (
          <p className="text-sm text-gray-500">{isFetching ? t(lang, 'loading') : t(lang, 'historyEmpty')}</p>
        ) : (
          <div className="space-y-1.5">
            {orders.map((o) => (
              <div key={o.id} className="flex items-center gap-3 rounded-xl border border-gray-100 px-3 py-2">
                <span className="font-bold tabular-nums text-gray-900 text-sm">#{o.daily_number}</span>
                <span className="text-xs text-gray-500 flex-1 tabular-nums">{formatDate(o.created_at, lang)}</span>
                <span className="text-sm font-bold text-gray-900 tabular-nums">{formatMoney(o.total, lang)}</span>
              </div>
            ))}
          </div>
        )}

        <button onClick={onClose} className="btn-ghost w-full mt-4">{t(lang, 'close')}</button>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-gray-50 border border-gray-100 p-3">
      <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide truncate">{label}</div>
      <div className="text-base font-black text-gray-900 tabular-nums mt-0.5">{value}</div>
    </div>
  )
}
