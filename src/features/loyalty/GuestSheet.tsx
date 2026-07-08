import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import type { CartGuest, CartRedeem } from '../../store/cartStore'
import { searchGuests, createGuest, normalizePhone, formatPhone, type Guest } from './api'

interface Props {
  mode: 'stamps' | 'points'
  stampsGoal: number
  minRedeem: number // агороты, порог списания баллов
  /** Цена самой дешёвой штампуемой позиции в корзине; null — таких нет */
  freeItemPrice: number | null
  /** Потолок вычета: подытог минус ручная скидка */
  maxRedeem: number
  current: CartGuest | null
  currentRedeem: CartRedeem | null
  onApply: (guest: CartGuest | null, redeem: CartRedeem | null) => void
  onCancel: () => void
}

function toCartGuest(g: Guest): CartGuest {
  return { id: g.id, phone: g.phone, name: g.name, stamps: g.stamps, points: g.points }
}

/**
 * Гость лояльности: поиск по телефону/имени, быстрое создание,
 * выбор награды (бесплатный напиток / списание баллов). Всё —
 * намерение; настоящие деньги и балансы считает сервер.
 */
export default function GuestSheet({
  mode, stampsGoal, minRedeem, freeItemPrice, maxRedeem,
  current, currentRedeem, onApply, onCancel,
}: Props) {
  const lang = useLangStore((s) => s.lang)
  const [sel, setSel] = useState<CartGuest | null>(current)
  const [query, setQuery] = useState('')
  const [newName, setNewName] = useState('')
  // Награда: черновик внутри диалога, наружу уходит по «Применить»
  const [useStamps, setUseStamps] = useState(currentRedeem?.type === 'stamps')
  const [pointsStr, setPointsStr] = useState(
    currentRedeem?.type === 'points' ? String(currentRedeem.amount / 100) : ''
  )

  const { data: results = [], isFetching } = useQuery({
    queryKey: ['guests', query],
    queryFn: () => searchGuests(query),
    enabled: !sel,
    placeholderData: (prev) => prev,
  })

  const create = useMutation({
    mutationFn: () => createGuest(query, newName),
    onSuccess: (g) => { setSel(toCartGuest(g)); setNewName('') },
    onError: (e) => toast.error(e.message),
  })

  const digits = normalizePhone(query)
  const canCreate = !sel && digits.length >= 7 && !results.some((g) => g.phone === digits)

  // ── Награда выбранного гостя ──
  const stampsReady = sel !== null && sel.stamps >= stampsGoal
  const freeAmount = freeItemPrice !== null ? Math.min(freeItemPrice, maxRedeem) : null

  const pointsAvail = sel !== null ? Math.min(sel.points, maxRedeem) : 0
  const pointsReady = sel !== null && sel.points >= minRedeem && pointsAvail > 0
  const pointsAmount = pointsStr ? parseMoney(pointsStr) : null
  const pointsValid = pointsAmount !== null && pointsAmount > 0 && pointsAmount <= pointsAvail

  function apply() {
    if (!sel) return
    let redeem: CartRedeem | null = null
    if (mode === 'stamps' && useStamps && stampsReady && freeAmount !== null) {
      redeem = { type: 'stamps', amount: freeAmount }
    } else if (mode === 'points' && pointsValid) {
      redeem = { type: 'points', amount: pointsAmount! }
    }
    onApply(sel, redeem)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="card w-full max-w-md p-6 short:p-4 max-h-[92vh] overflow-y-auto animate-[rise-in_0.2s_ease-out]">
        <h2 className="text-lg font-black text-gray-900 mb-4">{t(lang, 'guestTitle')}</h2>

        {!sel && (
          <>
            <input
              className="input"
              autoFocus
              inputMode="tel"
              placeholder={t(lang, 'guestSearchPh')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="mt-3 space-y-1.5 min-h-[120px]">
              {results.map((g) => (
                <button
                  key={g.id}
                  onClick={() => setSel(toCartGuest(g))}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-xl border border-gray-200 bg-white text-start
                             hover:border-gray-400 transition-all active:scale-[0.98] flex items-center justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="block font-semibold text-gray-900 text-sm truncate">
                      {g.name || formatPhone(g.phone)}
                    </span>
                    {g.name && <span className="block text-xs text-gray-500 tabular-nums">{formatPhone(g.phone)}</span>}
                  </span>
                  <span className="shrink-0 text-sm font-bold text-gray-500 tabular-nums">
                    {mode === 'stamps' ? `${g.stamps}/${stampsGoal}` : formatMoney(g.points, lang)}
                  </span>
                </button>
              ))}
              {results.length === 0 && !isFetching && (
                <p className="text-sm text-gray-400 text-center pt-8">{t(lang, 'guestNotFound')}</p>
              )}
            </div>

            {canCreate && (
              <div className="mt-3 rounded-2xl bg-gray-50 border border-gray-100 p-3 space-y-2">
                <div className="text-xs font-bold text-gray-400 uppercase tracking-wide">
                  {t(lang, 'newGuest')} · {formatPhone(digits)}
                </div>
                <input
                  className="input !py-2"
                  placeholder={t(lang, 'guestNamePh')}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <button
                  onClick={() => create.mutate()}
                  disabled={create.isPending}
                  className="btn-primary w-full !py-2.5"
                >
                  {t(lang, 'addGuest')}
                </button>
              </div>
            )}
          </>
        )}

        {sel && (
          <>
            {/* Карточка гостя */}
            <div className="rounded-2xl bg-gray-50 border border-gray-100 p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-bold text-gray-900 truncate">{sel.name || formatPhone(sel.phone)}</div>
                {sel.name && <div className="text-sm text-gray-500 tabular-nums">{formatPhone(sel.phone)}</div>}
              </div>
              <button
                onClick={() => { setSel(null); setUseStamps(false); setPointsStr('') }}
                className="shrink-0 text-sm font-semibold text-gray-500 hover:text-gray-900 min-h-[44px] px-2"
              >
                {t(lang, 'changeGuest')}
              </button>
            </div>

            {/* Баланс + награда */}
            {mode === 'stamps' && (
              <div className="mt-4">
                <div className="flex justify-between items-baseline mb-2">
                  <span className="text-sm text-gray-500">{t(lang, 'stampsBalance')}</span>
                  <span className="text-2xl font-black text-gray-900 tabular-nums">
                    {sel.stamps}<span className="text-gray-400 text-base font-bold"> / {stampsGoal}</span>
                  </span>
                </div>
                {/* Прогресс до бесплатного напитка */}
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden mb-3">
                  <div
                    className="h-full bg-gray-900 rounded-full transition-all"
                    style={{ width: `${Math.min(100, (sel.stamps / stampsGoal) * 100)}%` }}
                  />
                </div>
                {stampsReady && (
                  freeAmount !== null ? (
                    <button
                      onClick={() => setUseStamps((v) => !v)}
                      className={`w-full min-h-[52px] rounded-2xl border-2 px-4 flex items-center justify-between font-semibold text-sm
                                  transition-all active:scale-[0.98] ${
                        useStamps
                          ? 'border-gray-900 bg-gray-900 text-white'
                          : 'border-gray-200 bg-white text-gray-900 hover:border-gray-400'
                      }`}
                    >
                      <span>{t(lang, 'freeDrink')}</span>
                      <span className="tabular-nums">−{formatMoney(freeAmount, lang)}</span>
                    </button>
                  ) : (
                    <p className="text-sm text-gray-400">{t(lang, 'noStampableItem')}</p>
                  )
                )}
              </div>
            )}

            {mode === 'points' && (
              <div className="mt-4">
                <div className="flex justify-between items-baseline mb-3">
                  <span className="text-sm text-gray-500">{t(lang, 'pointsBalance')}</span>
                  <span className="text-2xl font-black text-gray-900 tabular-nums">{formatMoney(sel.points, lang)}</span>
                </div>
                {pointsReady ? (
                  <>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'redeemPointsLabel')}</label>
                    <div className="flex gap-2">
                      <input
                        className="input tabular-nums"
                        inputMode="decimal"
                        placeholder="0"
                        value={pointsStr}
                        onChange={(e) => setPointsStr(e.target.value)}
                      />
                      <button
                        onClick={() => setPointsStr(String(pointsAvail / 100))}
                        className="btn-secondary shrink-0 !px-4"
                      >
                        {t(lang, 'redeemAll')}
                      </button>
                    </div>
                    {pointsStr !== '' && !pointsValid && (
                      <p className="text-xs text-red-500 mt-1">
                        {t(lang, 'redeemMax')} {formatMoney(pointsAvail, lang)}
                      </p>
                    )}
                  </>
                ) : (
                  sel.points > 0 && (
                    <p className="text-sm text-gray-400">
                      {t(lang, 'redeemFrom')} {formatMoney(minRedeem, lang)}
                    </p>
                  )
                )}
              </div>
            )}

            <button
              onClick={apply}
              disabled={pointsStr !== '' && mode === 'points' && !pointsValid}
              className="btn-primary w-full !py-3.5 !rounded-2xl mt-5"
            >
              {t(lang, 'applyGuest')}
            </button>
            {current && (
              <button onClick={() => onApply(null, null)} className="btn-ghost w-full mt-2 !text-red-500">
                {t(lang, 'detachGuest')}
              </button>
            )}
          </>
        )}

        <button onClick={onCancel} className="btn-ghost w-full mt-1">
          {t(lang, 'cancel')}
        </button>
      </div>
    </div>
  )
}
