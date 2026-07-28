import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { formatMoney, parseMoney } from '../../../lib/money'
import { updateLoyaltySettings, type LoyaltySettings } from '../../loyalty/api'
import { Group, SegmentRow, InputRow } from '../ui'
import type { Location } from '../../../types'

/**
 * Категория «Лояльность» — настройки уровня точки (режим, цель штампов,
 * кешбэк, порог списания). Правит менеджер+ через update_location_config
 * (044/052/107): право 'manage' проверяет сервер, экран уже под
 * ProtectedRoute owner/manager.
 *
 * Категории, дающие штамп, задаются на самом товаре/категории меню
 * (menu_categories.loyalty_stamps) — в веб-кабинете ANGLE.
 */
export default function LoyaltySection({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  const mode = location?.loyalty_mode ?? 'off'
  const goal = location?.loyalty_stamps_goal ?? 0
  const percent = location?.loyalty_points_percent ?? 0
  const minRedeem = location?.loyalty_points_min_redeem ?? 0

  // Черновики числовых полей: сохраняем на blur, чтобы не слать RPC на букву
  const [goalStr, setGoalStr] = useState(String(goal))
  const [percentStr, setPercentStr] = useState(String(percent))
  const [minRedeemStr, setMinRedeemStr] = useState(String(minRedeem / 100))

  const save = useMutation({
    mutationFn: (patch: Partial<LoyaltySettings>) =>
      updateLoyaltySettings({
        loyalty_mode: patch.loyalty_mode ?? mode,
        loyalty_stamps_goal: patch.loyalty_stamps_goal ?? goal,
        loyalty_points_percent: patch.loyalty_points_percent ?? percent,
        loyalty_points_min_redeem: patch.loyalty_points_min_redeem ?? minRedeem,
      }),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ['current_location'] })
      const prev = qc.getQueryData(['current_location'])
      qc.setQueryData(['current_location'], (old: Location | undefined) =>
        old ? { ...old, ...patch } : old
      )
      return { prev }
    },
    onError: (e, _patch, ctx) => {
      qc.setQueryData(['current_location'], ctx?.prev)
      toast.error((e as Error).message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['current_location'] }),
  })

  return (
    <div className="space-y-6">
      <Group title={t(lang, 'loyaltyTitle')}>
        <SegmentRow<'off' | 'stamps' | 'points'>
          label={t(lang, 'loyaltyTitle')}
          hint={t(lang, 'loyaltyHint')}
          options={[
            { value: 'off', label: t(lang, 'loyaltyModeOff') },
            { value: 'stamps', label: t(lang, 'loyaltyModeStamps') },
            { value: 'points', label: t(lang, 'loyaltyModePoints') },
          ]}
          value={mode}
          onChange={(v) => save.mutate({ loyalty_mode: v })}
        />

        {mode === 'stamps' && (
          <InputRow label={t(lang, 'stampsGoalLabel')} hint={t(lang, 'stampsGoalHint')}>
            <input
              className="input tabular-nums w-28 shrink-0"
              inputMode="numeric"
              value={goalStr}
              onChange={(e) => setGoalStr(e.target.value)}
              onBlur={() => {
                const n = Math.round(Number(goalStr))
                if (!Number.isFinite(n) || n < 1 || n > 99) { setGoalStr(String(goal)); return }
                if (n !== goal) save.mutate({ loyalty_stamps_goal: n })
              }}
            />
          </InputRow>
        )}

        {mode === 'points' && (
          <>
            <InputRow label={t(lang, 'pointsPercentLabel')} hint={t(lang, 'pointsPercentHint')}>
              <input
                className="input tabular-nums w-28 shrink-0"
                inputMode="decimal"
                value={percentStr}
                onChange={(e) => setPercentStr(e.target.value)}
                onBlur={() => {
                  const n = Number(percentStr.replace(',', '.'))
                  if (!Number.isFinite(n) || n < 0 || n > 100) { setPercentStr(String(percent)); return }
                  if (n !== percent) save.mutate({ loyalty_points_percent: n })
                }}
              />
            </InputRow>
            <InputRow
              label={t(lang, 'minRedeemLabel')}
              hint={`${t(lang, 'redeemFrom')} ${formatMoney(minRedeem, lang)}`}
            >
              <input
                className="input tabular-nums w-28 shrink-0"
                inputMode="decimal"
                value={minRedeemStr}
                onChange={(e) => setMinRedeemStr(e.target.value)}
                onBlur={() => {
                  // Деньги — только целые агороты через parseMoney (инвариант 1)
                  const agorot = parseMoney(minRedeemStr)
                  if (agorot === null || agorot < 0) { setMinRedeemStr(String(minRedeem / 100)); return }
                  if (agorot !== minRedeem) save.mutate({ loyalty_points_min_redeem: agorot })
                }}
              />
            </InputRow>
          </>
        )}
      </Group>

      {mode !== 'off' && (
        <p className="text-xs text-gray-500 px-1">{t(lang, 'loyaltyStampCatsHint')}</p>
      )}
    </div>
  )
}
