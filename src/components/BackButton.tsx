import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'

/**
 * Кнопка «Назад» для страниц (шапка редактора/смены и т.п.): иконка-шеврон
 * в мягком квадрате + подпись. Стрелка зеркалится в RTL. Единый вид вместо
 * голого текстового «← Назад».
 */
export default function BackButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  const lang = useLangStore((s) => s.lang)
  return (
    <button
      onClick={onClick}
      className={`group inline-flex items-center gap-2 h-11 ps-2 pe-4 -ms-1 rounded-xl
                  text-sm font-semibold text-gray-500 hover:text-gray-900 hover:bg-gray-50
                  transition-colors active:scale-[0.97] ${className}`}
    >
      <span className="w-7 h-7 rounded-lg bg-gray-100 group-hover:bg-gray-200 flex items-center justify-center transition-colors">
        <svg className="w-4 h-4 rtl:-scale-x-100" viewBox="0 0 20 20" fill="none" aria-hidden>
          <path d="M12.5 4l-6 6 6 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {t(lang, 'back')}
    </button>
  )
}
