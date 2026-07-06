import { useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import NumPad from '../../components/NumPad'

interface Props {
  current: string
  onApply: (label: string) => void
  onCancel: () => void
}

/** Ввод номера стола нампадом (POS-планшет без клавиатуры). */
export default function TableSheet({ current, onApply, onCancel }: Props) {
  const lang = useLangStore((s) => s.lang)
  const [value, setValue] = useState(current)

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="card w-full max-w-xs p-6 animate-[rise-in_0.2s_ease-out]">
        <h2 className="text-lg font-black text-gray-900 mb-4">{t(lang, 'tableSheetTitle')}</h2>

        {/* Дисплей номера */}
        <div className="flex items-center justify-center rounded-2xl border border-gray-200 bg-gray-50 h-16 mb-4">
          <span className="text-3xl font-black text-gray-900 tabular-nums">{value || '—'}</span>
        </div>

        {/* Целые числа — стол это номер */}
        <NumPad value={value} onChange={setValue} decimal={false} />

        <button
          onClick={() => onApply(value)}
          disabled={!value}
          className="btn-primary w-full !py-3.5 !rounded-2xl mt-4"
        >
          {t(lang, 'apply')}
        </button>
        {current && (
          <button onClick={() => onApply('')} className="btn-ghost w-full mt-2">
            {t(lang, 'tableNone')}
          </button>
        )}
        <button onClick={onCancel} className="btn-ghost w-full mt-1">
          {t(lang, 'cancel')}
        </button>
      </div>
    </div>
  )
}
