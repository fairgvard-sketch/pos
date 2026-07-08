import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCategories, updateCategory } from '../menu/api'
import { updateLoyaltySettings, searchGuests, formatPhone, type LoyaltySettings } from '../loyalty/api'
import { useLangStore } from '../../store/langStore'
import { t, formatDate } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import type { Location } from '../../types'

const MODES = ['off', 'stamps', 'points'] as const

/** Таб «Лояльность»: механика точки + штампуемые категории + гости */
export default function LoyaltyTab({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  const [mode, setMode] = useState<LoyaltySettings['loyalty_mode']>('off')
  const [goal, setGoal] = useState('10')
  const [percent, setPercent] = useState('5')
  const [minRedeem, setMinRedeem] = useState('10') // ₪-строка
  useEffect(() => {
    if (!location) return
    setMode(location.loyalty_mode)
    setGoal(String(location.loyalty_stamps_goal))
    setPercent(String(Number(location.loyalty_points_percent)))
    setMinRedeem(String(location.loyalty_points_min_redeem / 100))
  }, [location])

  const goalNum = parseInt(goal, 10)
  const percentNum = Number(percent.replace(',', '.'))
  const minRedeemAg = parseMoney(minRedeem)
  const valid =
    (mode !== 'stamps' || (Number.isInteger(goalNum) && goalNum >= 2 && goalNum <= 50)) &&
    (mode !== 'points' ||
      (Number.isFinite(percentNum) && percentNum >= 0 && percentNum <= 50 && minRedeemAg !== null && minRedeemAg >= 0))

  const save = useMutation({
    mutationFn: () =>
      updateLoyaltySettings({
        loyalty_mode: mode,
        loyalty_stamps_goal: Number.isInteger(goalNum) ? goalNum : 10,
        loyalty_points_percent: Number.isFinite(percentNum) ? percentNum : 5,
        loyalty_points_min_redeem: minRedeemAg ?? 1000,
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['current_location'] }); toast.success(t(lang, 'saved')) },
    onError: (e) => toast.error(e.message),
  })

  // ── Штампуемые категории ──
  const { data: categories = [] } = useQuery({ queryKey: ['menu_categories'], queryFn: fetchCategories })
  const toggleCat = useMutation({
    mutationFn: (v: { id: string; on: boolean }) => updateCategory(v.id, { loyalty_stamps: v.on }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu_categories'] }),
    onError: (e) => toast.error(e.message),
  })

  // ── Гости ──
  const [guestQuery, setGuestQuery] = useState('')
  const { data: guests = [] } = useQuery({
    queryKey: ['guests', guestQuery],
    queryFn: () => searchGuests(guestQuery),
    placeholderData: (prev) => prev,
  })

  return (
    <>
      <section className="max-w-2xl">
        <h2 className="text-base font-bold text-gray-900">{t(lang, 'loyaltyTitle')}</h2>
        <p className="text-sm text-gray-500 mt-1 mb-4">{t(lang, 'loyaltyHint')}</p>

        <div className="inline-flex rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5 mb-4">
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`h-11 px-4 rounded-lg text-sm font-semibold transition-all ${
                mode === m
                  ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              {t(lang, m === 'off' ? 'loyaltyModeOff' : m === 'stamps' ? 'loyaltyModeStamps' : 'loyaltyModePoints')}
            </button>
          ))}
        </div>

        {mode === 'stamps' && (
          <div className="space-y-4">
            <label className="block">
              <span className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
                {t(lang, 'stampsGoalLabel')}
              </span>
              <input
                className="input max-w-[120px] tabular-nums"
                inputMode="numeric"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </label>
            <div>
              <span className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">
                {t(lang, 'stampCategoriesLabel')}
              </span>
              <div className="space-y-1.5">
                {categories.filter((c) => c.is_active).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => toggleCat.mutate({ id: c.id, on: !c.loyalty_stamps })}
                    className="w-full min-h-[44px] px-4 rounded-xl border border-gray-200 bg-white flex items-center
                               justify-between gap-3 hover:border-gray-400 transition-all active:scale-[0.99]"
                  >
                    <span className="font-semibold text-gray-900 text-sm">{c.name}</span>
                    <span
                      className={`w-10 h-6 rounded-full p-0.5 transition-colors ${
                        c.loyalty_stamps ? 'bg-gray-900' : 'bg-gray-200'
                      }`}
                    >
                      <span
                        className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${
                          c.loyalty_stamps ? 'translate-x-4 rtl:-translate-x-4' : ''
                        }`}
                      />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {mode === 'points' && (
          <div className="flex gap-4">
            <label className="block">
              <span className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
                {t(lang, 'pointsPercentLabel')}
              </span>
              <input
                className="input max-w-[120px] tabular-nums"
                inputMode="decimal"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
                {t(lang, 'minRedeemLabel')}
              </span>
              <input
                className="input max-w-[120px] tabular-nums"
                inputMode="decimal"
                value={minRedeem}
                onChange={(e) => setMinRedeem(e.target.value)}
              />
            </label>
          </div>
        )}

        <button
          onClick={() => save.mutate()}
          disabled={!valid || save.isPending}
          className="btn-primary !py-2.5 !px-6 mt-4"
        >
          {t(lang, 'save')}
        </button>
      </section>

      <section className="max-w-2xl mt-10">
        <h2 className="text-base font-bold text-gray-900 mb-3">{t(lang, 'guestsTitle')}</h2>
        <input
          className="input mb-3"
          placeholder={t(lang, 'guestSearchPh')}
          value={guestQuery}
          onChange={(e) => setGuestQuery(e.target.value)}
        />
        <div className="space-y-1.5">
          {guests.map((g) => (
            <div
              key={g.id}
              className="px-4 py-2.5 rounded-xl border border-gray-100 bg-white flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="font-semibold text-gray-900 text-sm truncate">{g.name || formatPhone(g.phone)}</div>
                <div className="text-xs text-gray-500 tabular-nums">
                  {g.name && `${formatPhone(g.phone)} · `}
                  {t(lang, 'guestVisits')}: {g.visits}
                  {g.last_visit_at && ` · ${formatDate(g.last_visit_at, lang)}`}
                </div>
              </div>
              <div className="shrink-0 text-sm font-bold text-gray-900 tabular-nums text-end">
                {mode === 'points' || location?.loyalty_mode === 'points'
                  ? formatMoney(g.points, lang)
                  : `${g.stamps} ${t(lang, 'stampsShort')}`}
              </div>
            </div>
          ))}
          {guests.length === 0 && <p className="text-sm text-gray-400 text-center py-6">{t(lang, 'guestNotFound')}</p>}
        </div>
      </section>
    </>
  )
}
