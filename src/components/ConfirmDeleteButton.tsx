import { useState, useRef, useEffect } from 'react'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'

interface Props {
  onConfirm: () => void
  /** Классы иконки-крестика в спокойном состоянии */
  className?: string
}

/**
 * Кнопка удаления с инлайн-подтверждением: первый тап раскрывает «Удалить?»,
 * второй — удаляет. Клик вне/Esc — отмена. Заменяет системный confirm().
 */
export default function ConfirmDeleteButton({ onConfirm, className = 'text-gray-300 hover:text-red-500' }: Props) {
  const lang = useLangStore((s) => s.lang)
  const [armed, setArmed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!armed) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setArmed(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setArmed(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [armed])

  if (armed) {
    return (
      <div ref={ref} className="flex items-center gap-1.5">
        <button
          onClick={(e) => { e.stopPropagation(); onConfirm(); setArmed(false) }}
          className="h-8 px-3 rounded-lg bg-red-500 text-white text-xs font-semibold hover:bg-red-600 transition-colors active:scale-[0.96]"
        >
          {t(lang, 'delete')}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setArmed(false) }}
          className="h-8 px-3 rounded-lg bg-gray-100 text-gray-600 text-xs font-semibold hover:bg-gray-200 transition-colors active:scale-[0.96]"
        >
          {t(lang, 'cancel')}
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); setArmed(true) }}
      className={`transition-colors ${className}`}
      aria-label={t(lang, 'delete')}
    >
      ✕
    </button>
  )
}
