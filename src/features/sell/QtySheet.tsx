import { useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import NumPad from '../../components/NumPad'

interface Props {
  // Название строки — заголовок панели
  name: string
  qty: number
  // qty = 0 означает «удалить строку» (updateQty в сторе так и трактует)
  onSubmit: (qty: number) => void
  onCancel: () => void
}

/** Компактная панель изменения количества строки заказа: −/+ и клавиатура. */
export default function QtySheet({ name, qty, onSubmit, onCancel }: Props) {
  const lang = useLangStore((s) => s.lang)
  const [str, setStr] = useState(String(qty))

  const value = str === '' ? 0 : parseInt(str, 10)
  const removing = value === 0

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="card w-full max-w-xs p-6 short:p-4 animate-[rise-in_0.2s_ease-out]">
        <h2 className="text-lg font-black text-gray-900 mb-1">{t(lang, 'qtyTitle')}</h2>
        <p className="text-sm text-gray-500 mb-4 truncate">{name}</p>

        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => setStr(String(Math.max(0, value - 1)))}
            className="w-12 h-12 rounded-xl bg-gray-50 border border-gray-200 text-lg font-bold text-gray-600
                       flex items-center justify-center hover:border-gray-400 active:scale-[0.94] transition-all"
          >
            −
          </button>
          <div className="flex-1 h-12 rounded-xl border border-gray-200 bg-gray-50 flex items-center justify-center">
            <span className="text-2xl font-black text-gray-900 tabular-nums">{value}</span>
          </div>
          <button
            onClick={() => setStr(String(value + 1))}
            className="w-12 h-12 rounded-xl bg-gray-50 border border-gray-200 text-lg font-bold text-gray-600
                       flex items-center justify-center hover:border-gray-400 active:scale-[0.94] transition-all"
          >
            +
          </button>
        </div>

        <NumPad value={str === '0' ? '' : str} onChange={setStr} decimal={false} />

        <button
          onClick={() => onSubmit(value)}
          className={`${removing ? 'btn-danger' : 'btn-primary'} w-full !py-3.5 !rounded-2xl mt-4`}
        >
          {t(lang, removing ? 'delete' : 'save')}
        </button>
        <button onClick={onCancel} className="btn-ghost w-full mt-1">
          {t(lang, 'cancel')}
        </button>
      </div>
    </div>
  )
}
