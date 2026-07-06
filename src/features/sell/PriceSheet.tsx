import { useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import type { CartLine } from '../../store/cartStore'
import NumPad from '../../components/NumPad'

interface CustomResult {
  name: string
  priceOverride: number
}

interface Props {
  // Режим 'custom' — новая свободная позиция; 'edit' — правка цены строки
  mode: 'custom' | 'edit'
  // Для edit: строка, цену которой правим
  line?: CartLine
  // Каталожная (авто) цена строки — для кнопки «вернуть из меню»
  autoPrice?: number
  onSubmit: (r: CustomResult) => void
  onReset?: () => void // сбросить override к каталожной цене (edit)
  onCancel: () => void
}

/** Диалог свободной позиции или ручной правки цены строки заказа. */
export default function PriceSheet({ mode, line, autoPrice, onSubmit, onReset, onCancel }: Props) {
  const lang = useLangStore((s) => s.lang)
  const [name, setName] = useState(mode === 'edit' ? line?.name ?? '' : '')
  const [priceStr, setPriceStr] = useState(() => {
    const cur = line?.priceOverride ?? autoPrice ?? null
    return cur !== null ? String(cur / 100) : ''
  })

  const price = parseMoney(priceStr)
  const nameOk = mode === 'edit' || name.trim().length > 0
  const valid = price !== null && price >= 0 && nameOk

  function submit() {
    if (!valid) return
    onSubmit({ name: name.trim(), priceOverride: price! })
  }

  const isOverridden = mode === 'edit' && line?.priceOverride !== null

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="card w-full max-w-md p-6 animate-[rise-in_0.2s_ease-out]">
        <h2 className="text-lg font-black text-gray-900 mb-4">
          {t(lang, mode === 'custom' ? 'customItemTitle' : 'editPriceTitle')}
        </h2>

        {mode === 'custom' && (
          <div className="mb-4">
            <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'customItemName')}</label>
            <input
              className="input"
              autoFocus
              placeholder={t(lang, 'customItemNamePh')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        )}

        {mode === 'edit' && (
          <div className="mb-4 font-semibold text-gray-900">{line?.name}</div>
        )}

        <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'priceLabel')}</label>
        <div className="flex items-center justify-between rounded-2xl border border-gray-200 bg-gray-50 px-4 h-14 mb-1">
          <span className="text-2xl font-black text-gray-900 tabular-nums">{priceStr || '0'}</span>
          <span className="text-gray-400 font-semibold text-lg">₪</span>
        </div>
        {mode === 'edit' && autoPrice !== undefined && (
          <p className="text-xs text-gray-500 mb-3">
            {t(lang, 'menu')}: {formatMoney(autoPrice, lang)}
          </p>
        )}
        {mode === 'custom' && <div className="mb-3" />}

        <NumPad value={priceStr} onChange={setPriceStr} decimal />
        <div className="mb-4" />

        <button onClick={submit} disabled={!valid} className="btn-primary w-full !py-3.5 !rounded-2xl">
          {t(lang, mode === 'custom' ? 'add' : 'save')}
        </button>
        {mode === 'edit' && isOverridden && onReset && (
          <button onClick={onReset} className="btn-ghost w-full mt-2">
            {t(lang, 'resetPrice')}
          </button>
        )}
        <button onClick={onCancel} className="btn-ghost w-full mt-1">
          {t(lang, 'cancel')}
        </button>
      </div>
    </div>
  )
}
