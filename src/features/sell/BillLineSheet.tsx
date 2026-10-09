import { useState } from 'react'
import { t, type Lang, type TranslationKey } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import Icon from '../../components/Icon'
import type { Table } from '../../types'
import type { BillLine } from '../tables/api'

export type BillLineSheetMode = 'menu' | 'void' | 'move'

/** Стол-приёмник переноса: касса даёт Table, телефон официанта — стол зала (182) */
export type MoveTable = Pick<Table, 'id' | 'label' | 'status'> & { is_active?: boolean }

interface Props {
  line: BillLine
  lang: Lang
  isRtl: boolean
  initialMode: BillLineSheetMode
  /** Сколько убрать в режиме void: null — всю строку */
  initialVoidQty: number | null
  tables: MoveTable[]
  occupancy: Map<string, { staff_name: string | null }>
  currentTableId: string
  online: boolean
  /** Строка офлайн-эха ещё не на сервере — править нельзя до синхронизации */
  synced: boolean
  busy: boolean
  /** Нет — «+» недоступен (позиция без каталога на телефоне) */
  onAddOne?: () => void
  onFire?: () => void
  /** Вернуть 'bad_pin', если сервер не принял PIN менеджера */
  onVoid: (qty: number | null, reason: string, pin: string) => Promise<'ok' | 'bad_pin' | 'error'>
  onMove: (tableId: string) => void
  onClose: () => void
}

const PIN_LENGTH = 4
const REASONS: TranslationKey[] = ['voidReasonMistake', 'voidReasonGuest', 'reasonOther']

/**
 * Отправленная позиция счёта стола (181): количество, Fire, перенос на
 * другой стол, удаление. Убрать отправленное — только с PIN менеджера
 * или владельца: окно открывает любой сотрудник, PIN вводит менеджер.
 * Добавить порцию — в новые позиции, они уходят кнопкой «Отправить».
 */
export default function BillLineSheet({
  line, lang, isRtl, initialMode, initialVoidQty, tables, occupancy, currentTableId,
  online, synced, busy, onAddOne, onFire, onVoid, onMove, onClose,
}: Props) {
  const [mode, setMode] = useState<BillLineSheetMode>(initialMode)
  const [voidQty, setVoidQty] = useState<number | null>(initialVoidQty)
  const [reason, setReason] = useState<TranslationKey>(REASONS[0])
  const [pin, setPin] = useState('')
  const [badPin, setBadPin] = useState(false)
  const [checking, setChecking] = useState(false)

  const removing = voidQty ?? line.qty
  const editable = online && synced
  const blockedHint = !synced ? t(lang, 'lineSyncPending') : !online ? t(lang, 'offlineBlockedHint') : null

  function startVoid(qty: number | null) {
    setVoidQty(qty)
    setPin('')
    setBadPin(false)
    setMode('void')
  }

  async function press(d: string) {
    if (checking) return
    const next = (pin + d).slice(0, PIN_LENGTH)
    setPin(next)
    setBadPin(false)
    if (next.length < PIN_LENGTH) return
    setChecking(true)
    try {
      // Вся строка — null: сервер уберёт её целиком, без отменённой копии
      const res = await onVoid(removing >= line.qty ? null : removing, t(lang, reason), next)
      if (res === 'bad_pin') setBadPin(true)
      // Ошибку сети/сервера показал тост — PIN вводят заново
      if (res !== 'ok') setPin('')
    } finally {
      setChecking(false)
    }
  }

  const moveTargets = tables.filter((tb) => tb.id !== currentTableId && tb.is_active !== false && tb.status !== 'disabled')

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
      onClick={() => !checking && onClose()}
    >
      <div className="card w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 px-6 pt-6 pb-4 border-b border-gray-100">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-bold text-gray-900 min-w-0">
              <span className="tabular-nums">{line.qty}× </span>{line.name}
              {line.variant_name && <span className="text-gray-500 font-semibold"> · {line.variant_name}</span>}
            </h2>
            <span className="font-black text-gray-900 tabular-nums shrink-0">{formatMoney(line.line_total, lang)}</span>
          </div>
          {(line.modifiers.length > 0 || line.notes) && (
            <p className="text-sm text-gray-500 mt-1">{[...line.modifiers, line.notes].filter(Boolean).join(' · ')}</p>
          )}
        </div>

        {mode === 'menu' && (
          <div className="px-6 py-4 space-y-3 overflow-y-auto">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-gray-700">{t(lang, 'qtyTitle')}</span>
              <div className="flex items-center gap-1" dir="ltr">
                <button
                  onClick={() => startVoid(1)}
                  disabled={!editable || busy}
                  aria-label={`− ${line.name}`}
                  className="w-12 h-12 rounded-xl border border-gray-200 bg-white text-xl font-bold text-gray-900 active:scale-[0.95] disabled:opacity-40"
                >
                  −
                </button>
                <span className="w-10 text-center text-lg font-bold text-gray-900 tabular-nums">{line.qty}</span>
                <button
                  onClick={onAddOne}
                  disabled={busy || !onAddOne || line.menu_item_id === undefined}
                  aria-label={`+ ${line.name}`}
                  className="w-12 h-12 rounded-xl bg-gray-900 text-white text-xl font-bold active:scale-[0.95] disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </div>

            {blockedHint && <p className="text-sm text-gray-500">{blockedHint}</p>}

            {line.held && onFire && (
              <button onClick={onFire} disabled={busy} className="btn-primary w-full !h-12 gap-2">
                <Icon name="fire" size={18} />
                {t(lang, 'fireItem')}
              </button>
            )}
            <button
              onClick={() => setMode('move')}
              disabled={!editable || busy || moveTargets.length === 0}
              className="btn-secondary w-full !h-12"
            >
              {t(lang, 'moveTable')}
            </button>
            <button
              onClick={() => startVoid(null)}
              disabled={!editable || busy}
              className="w-full h-12 rounded-xl border border-red-200 bg-white text-red-600 text-sm font-semibold active:scale-[0.97] disabled:opacity-40"
            >
              {t(lang, 'lineRemove')}
            </button>
            <button onClick={onClose} className="btn-ghost w-full !h-12">{t(lang, 'close')}</button>
          </div>
        )}

        {mode === 'void' && (
          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            {/* Сколько убираем — видно до PIN; менеджер подтверждает именно это */}
            {line.qty > 1 && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-gray-700">{t(lang, 'voidQtyLabel')}</span>
                <div className="flex items-center gap-1">
                  <div className="flex items-center gap-1" dir="ltr">
                    <button
                      onClick={() => setVoidQty(Math.max(1, removing - 1))}
                      disabled={checking || removing <= 1}
                      aria-label={`− ${t(lang, 'voidQtyLabel')}`}
                      className="w-11 h-11 rounded-xl border border-gray-200 bg-white text-xl font-bold text-gray-900 active:scale-[0.95] disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="w-9 text-center text-lg font-bold text-gray-900 tabular-nums" data-testid="void-qty">{removing}</span>
                    <button
                      onClick={() => setVoidQty(Math.min(line.qty, removing + 1))}
                      disabled={checking || removing >= line.qty}
                      aria-label={`+ ${t(lang, 'voidQtyLabel')}`}
                      className="w-11 h-11 rounded-xl border border-gray-200 bg-white text-xl font-bold text-gray-900 active:scale-[0.95] disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                  <span className="text-sm text-gray-500 tabular-nums">{t(lang, 'voidQtyOf').replace('{n}', String(line.qty))}</span>
                </div>
              </div>
            )}

            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">{t(lang, 'voidReasonLabel')}</div>
              <div className="flex flex-wrap gap-2">
                {REASONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => setReason(r)}
                    className={`h-11 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.97] ${
                      reason === r ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-700'
                    }`}
                  >
                    {t(lang, r)}
                  </button>
                ))}
              </div>
            </div>

            <div className="text-center">
              <div className="text-base font-bold text-gray-900">{t(lang, 'managerPinTitle')}</div>
              <p className={`text-sm mt-1 ${badPin ? 'text-gray-900 font-semibold' : 'text-gray-500'}`} role={badPin ? 'alert' : undefined}>
                {badPin ? t(lang, 'managerPinInvalid') : checking ? t(lang, 'checking') : t(lang, 'managerPinHint')}
              </p>
              <div className={`flex justify-center gap-3 mt-3 ${badPin ? 'animate-[shake_0.4s_ease-in-out]' : ''}`}>
                {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                  <div key={i} className={`w-3.5 h-3.5 rounded-full ${i < pin.length ? 'bg-gray-900' : 'bg-gray-200'}`} />
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 max-w-[264px] mx-auto" dir="ltr">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button
                  key={d}
                  onClick={() => void press(d)}
                  disabled={checking}
                  className="card h-14 text-xl font-bold text-gray-900 active:scale-[0.95]"
                >
                  {d}
                </button>
              ))}
              <button onClick={() => void press('0')} disabled={checking} className="card col-span-2 h-14 text-xl font-bold text-gray-900 active:scale-[0.95]">0</button>
              <button onClick={() => setPin((p) => p.slice(0, -1))} disabled={checking} className="btn-ghost h-14 text-lg" aria-label="backspace">⌫</button>
            </div>

            <button onClick={() => setMode('menu')} disabled={checking} className="btn-ghost w-full !h-12">{t(lang, 'back')}</button>
          </div>
        )}

        {mode === 'move' && (
          <div className="px-6 py-4 space-y-3 overflow-y-auto">
            <div className="text-base font-bold text-gray-900">{t(lang, 'lineMoveTitle')}</div>
            <div className="grid grid-cols-3 gap-2">
              {moveTargets.map((tb) => {
                const occ = occupancy.get(tb.id)
                return (
                  <button
                    key={tb.id}
                    onClick={() => onMove(tb.id)}
                    disabled={busy}
                    className={`min-h-16 rounded-xl border-2 bg-white px-2 py-2 flex flex-col items-center justify-center active:scale-[0.97] disabled:opacity-40 ${
                      occ ? 'border-amber-400' : 'border-emerald-500'
                    }`}
                  >
                    <span className="text-lg font-black text-gray-900 leading-none">{tb.label}</span>
                    {occ?.staff_name && <span className="max-w-full truncate text-[11px] font-semibold text-gray-500 mt-1">{occ.staff_name}</span>}
                  </button>
                )
              })}
            </div>
            <button onClick={() => setMode('menu')} className="btn-ghost w-full !h-12">{t(lang, 'back')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
