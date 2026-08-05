import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { t, type Lang } from '../../lib/i18n'

interface Props {
  lang: Lang
  /** Заголовок листа; он же aria-label диалога */
  title: string
  /** Вторая строка шапки: имя гостя, сотрудник, номер документа */
  subtitle?: ReactNode
  onClose: () => void
  /** Кнопки действия; лежат в нижней панели, всегда видимы */
  footer?: ReactNode
  /** `wide` — для форм со списком позиций (приёмка, возврат, инвентаризация) */
  width?: 'default' | 'wide'
  /** Слой; нужен, когда форма открывается поверх другого оверлея */
  zClass?: string
  children: ReactNode
}

/**
 * Полноэкранный лист формы ввода.
 *
 * Карточка `max-w-md` по центру затемнения на ландшафтном 1920×1080 T2
 * выглядит узкой полоской: поля мельче сенсорной нормы, а половина экрана
 * простаивает. Форма ввода занимает весь экран — шапка с закрытием, колонка
 * полей по центру, действие в нижней панели под пальцем.
 *
 * Не для коротких подтверждений (да/нет, PIN, количество, чаевые): там
 * лишний полноэкранный переход только замедляет горячий поток.
 */
export default function FormSheet({
  lang, title, subtitle, onClose, footer, width = 'default', zClass = 'z-50', children,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const col = width === 'wide' ? 'max-w-3xl' : 'max-w-xl'

  return (
    <div
      dir={lang === 'he' ? 'rtl' : 'ltr'}
      className={`fixed inset-0 ${zClass} flex flex-col bg-white`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="shrink-0 flex items-center gap-3 border-b border-gray-100 px-4 py-3 short:py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={t(lang, 'close')}
          className="h-11 w-11 shrink-0 rounded-xl bg-gray-100 text-lg font-bold text-gray-600 active:scale-[0.95] transition-transform"
        >
          ✕
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-black text-gray-900">{title}</h2>
          {subtitle && <div className="truncate text-sm text-gray-500">{subtitle}</div>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto w-full ${col} px-4 py-6 short:py-4`}>{children}</div>
      </div>

      {footer && (
        <div className="shrink-0 border-t border-gray-100">
          <div className={`mx-auto w-full ${col} flex gap-3 px-4 py-3`}>{footer}</div>
        </div>
      )}
    </div>
  )
}
