import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../../store/langStore'
import { t, formatDate } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import { fetchCurrentLocation } from '../auth/api'
import AppSidebar from '../../components/AppSidebar'
import {
  searchGuests, fetchGuestCard, updateGuest, formatPhone, type Guest,
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
      <AppSidebar active="guests" />

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

/**
 * Карточка гостя (114): профиль, баланс, любимые позиции, заметка,
 * заказы С СОСТАВОМ («что покупал») и журнал начислений/списаний.
 * Всё приходит одним RPC — сервер уже склеил orders/order_items/events.
 */
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
  // Черновик заметки: null — пользователь ещё не трогал поле, показываем
  // серверное значение. Так не нужен эффект-синхронизатор (он давал
  // каскадный рендер) и ввод не затирается ответом сервера.
  const [notesDraft, setNotesDraft] = useState<string | null>(null)
  const [openOrder, setOpenOrder] = useState<string | null>(null)
  const [tab, setTab] = useState<'orders' | 'events'>('orders')

  const { data: card, isFetching } = useQuery({
    queryKey: ['guest_card', guest.id],
    queryFn: () => fetchGuestCard(guest.id),
  })

  const serverNotes = card?.notes ?? ''
  const notes = notesDraft ?? serverNotes

  const save = useMutation({
    mutationFn: () => updateGuest(guest.id, { name, notes }),
    onSuccess: () => {
      toast.success(t(lang, 'saved'))
      // Сохранённое значение снова берём с сервера
      setNotesDraft(null)
      qc.invalidateQueries({ queryKey: ['guests'] })
      qc.invalidateQueries({ queryKey: ['guest_card', guest.id] })
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const dirty = name.trim() !== (guest.name ?? '').trim()
    || notes.trim() !== serverNotes.trim()

  const orders = card?.orders ?? []
  const favorites = card?.favorites ?? []
  const rsv = card?.reservations
  const tags = card?.tags ?? []
  const events = card?.events ?? []

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div
        className="card w-full max-w-lg p-6 max-h-[92vh] overflow-y-auto animate-[rise-in_0.2s_ease-out]"
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

        {/* Ресторанное поведение (121): визиты, неявки, любимая зона.
            Заполнено и у точки без кассы — там пусты как раз заказы. */}
        {rsv && rsv.total > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">
              {t(lang, 'guestBookings')}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              <span className="badge-gray">
                {t(lang, 'guestBookingVisits')} · <span className="tabular-nums">{rsv.visits}</span>
              </span>
              {rsv.upcoming > 0 && (
                <span className="badge-blue">
                  {t(lang, 'guestBookingUpcoming')} · <span className="tabular-nums">{rsv.upcoming}</span>
                </span>
              )}
              {rsv.no_shows > 0 && (
                <span className="inline-flex items-center rounded-full bg-red-50 text-red-700 px-2 py-0.5 text-xs font-semibold">
                  {t(lang, 'resGuestNoShows')} · <span className="tabular-nums">{rsv.no_shows}</span>
                </span>
              )}
              {rsv.zone && <span className="badge-gray">{rsv.zone}</span>}
              {rsv.avg_party && (
                <span className="badge-gray">
                  ~{rsv.avg_party} {t(lang, 'resGuestsShort')}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Метки — внутренние, наружу не уходят */}
        {tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className="badge-gray">{tag}</span>
            ))}
          </div>
        )}

        {/* Любимые позиции — бариста сразу видит, что человек берёт обычно */}
        {favorites.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">
              {t(lang, 'guestFavorites')}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {favorites.map((f) => (
                <span key={f.name} className="badge-gray">
                  {f.name} · <span className="tabular-nums">{f.qty}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <label className="block mt-4">
          <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">
            {t(lang, 'guestNamePh')}
          </span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="block mt-3">
          <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">
            {t(lang, 'guestNotesLabel')}
          </span>
          <input
            className="input"
            placeholder={t(lang, 'guestNotesPh')}
            value={notes}
            onChange={(e) => setNotesDraft(e.target.value)}
          />
        </label>

        <button
          className="btn-secondary w-full mt-3"
          disabled={save.isPending || !dirty}
          onClick={() => save.mutate()}
        >
          {t(lang, 'save')}
        </button>

        {/* Заказы / движения баллов */}
        <div className="inline-flex rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5 mt-6">
          {([['orders', 'guestLastOrders'], ['events', 'guestPointsLog']] as const).map(([v, key]) => (
            <button
              key={v}
              onClick={() => setTab(v)}
              className={`h-10 px-4 rounded-lg text-sm font-semibold transition-all whitespace-nowrap ${
                tab === v
                  ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t(lang, key)}
            </button>
          ))}
        </div>

        <div className="mt-3">
          {tab === 'orders' ? (
            orders.length === 0 ? (
              <p className="text-sm text-gray-500">{isFetching ? t(lang, 'loading') : t(lang, 'historyEmpty')}</p>
            ) : (
              <div className="space-y-1.5">
                {orders.map((o) => (
                  <div key={o.id} className="rounded-xl border border-gray-100 overflow-hidden">
                    {/* Тап раскрывает состав заказа — «что покупал» */}
                    <button
                      onClick={() => setOpenOrder(openOrder === o.id ? null : o.id)}
                      className="w-full min-h-11 flex items-center gap-3 px-3 py-2 text-start hover:bg-gray-50 transition-colors"
                    >
                      <span className="font-bold tabular-nums text-gray-900 text-sm">#{o.daily_number}</span>
                      <span className="text-xs text-gray-500 flex-1 tabular-nums">{formatDate(o.created_at, lang)}</span>
                      <span className="text-sm font-bold text-gray-900 tabular-nums">{formatMoney(o.total, lang)}</span>
                      <span className="text-gray-400 text-xs">{openOrder === o.id ? '▴' : '▾'}</span>
                    </button>
                    {openOrder === o.id && (
                      <div className="px-3 pb-2 pt-1 bg-gray-50 border-t border-gray-100 space-y-1">
                        {o.items.length === 0 ? (
                          <p className="text-xs text-gray-500 py-1">{t(lang, 'historyEmpty')}</p>
                        ) : (
                          o.items.map((it, i) => (
                            <div key={i} className="flex items-baseline gap-2 text-xs">
                              <span className="tabular-nums text-gray-500 shrink-0">{it.qty}×</span>
                              <span className="flex-1 text-gray-900 truncate">
                                {it.name}
                                {it.variant_name && <span className="text-gray-500"> · {it.variant_name}</span>}
                              </span>
                              <span className="tabular-nums text-gray-900 shrink-0">
                                {formatMoney(it.line_total, lang)}
                              </span>
                            </div>
                          ))
                        )}
                        {o.loyalty_discount > 0 && (
                          <div className="flex items-baseline gap-2 text-xs pt-1 border-t border-gray-200">
                            <span className="flex-1 text-gray-500">{t(lang, 'loyaltyLabel')}</span>
                            <span className="tabular-nums text-gray-900">
                              −{formatMoney(o.loyalty_discount, lang)}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          ) : events.length === 0 ? (
            <p className="text-sm text-gray-500">{isFetching ? t(lang, 'loading') : t(lang, 'historyEmpty')}</p>
          ) : (
            <div className="space-y-1.5">
              {events.map((e, i) => {
                const delta = mode === 'stamps' ? e.stamps_delta : e.points_delta
                const positive = delta > 0
                return (
                  <div key={i} className="flex items-center gap-3 rounded-xl border border-gray-100 px-3 py-2">
                    <span className="text-xs text-gray-500 flex-1 tabular-nums">{formatDate(e.created_at, lang)}</span>
                    <span className={`text-sm font-bold tabular-nums ${positive ? 'text-emerald-700' : 'text-gray-900'}`}>
                      {positive ? '+' : ''}
                      {mode === 'stamps' ? delta : formatMoney(Math.abs(delta), lang)}
                      {mode === 'stamps' ? ` ${t(lang, 'stampsShort')}` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

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
