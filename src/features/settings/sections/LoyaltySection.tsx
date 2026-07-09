import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCategories, updateCategory } from '../../menu/api'
import { updateLoyaltySettings, type LoyaltySettings } from '../../loyalty/api'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { parseMoney } from '../../../lib/money'
import { Group, NavRow, Segment, Toggle } from '../ui'
import type { DetailId } from '../registry'
import type { Location } from '../../../types'

const MODES = ['off', 'stamps', 'points'] as const

/** Категория «Лояльность»: механика точки + штампуемые категории + гости (drill-down) */
export default function LoyaltySection({
  location, openDetail,
}: { location: Location | undefined; openDetail: (id: DetailId) => void }) {
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

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2 px-1">
          {t(lang, 'loyaltyTitle')}
        </h3>
        <p className="text-sm text-gray-500 mb-3 px-1">{t(lang, 'loyaltyHint')}</p>

        <Segment
          options={MODES.map((m) => ({
            value: m,
            label: t(lang, m === 'off' ? 'loyaltyModeOff' : m === 'stamps' ? 'loyaltyModeStamps' : 'loyaltyModePoints'),
          }))}
          value={mode}
          onChange={setMode}
        />

        {mode === 'stamps' && (
          <div className="space-y-4 mt-4">
            <label className="block">
              <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">
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
              <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">
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
                    <span className="pointer-events-none">
                      <Toggle checked={c.loyalty_stamps} onChange={() => {}} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {mode === 'points' && (
          <div className="flex gap-4 mt-4">
            <label className="block">
              <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">
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
              <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">
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

      <Group>
        <NavRow label={t(lang, 'guestsTitle')} onClick={() => openDetail('guests')} />
      </Group>
    </div>
  )
}
