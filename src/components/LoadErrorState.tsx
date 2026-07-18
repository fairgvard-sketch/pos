import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'

/**
 * Явное состояние «критический запрос упал и кэша нет» (P1-7). Такую ошибку
 * нельзя маскировать под пустоту: «смена не открыта», «зал свободен» или
 * «меню пусто» подталкивают кассира к неверным действиям. Блок без
 * собственного позиционирования — центрирует родитель.
 */
export default function LoadErrorState({
  title,
  hint,
  onRetry,
}: {
  title: string
  hint?: string
  onRetry: () => void
}) {
  const lang = useLangStore((s) => s.lang)
  return (
    <div className="text-center">
      <p className="text-gray-900 text-sm font-semibold">{title}</p>
      <p className="text-gray-500 text-sm mt-1 max-w-sm mx-auto">{hint ?? t(lang, 'dataLoadErrorHint')}</p>
      <button className="btn-secondary mt-4" onClick={onRetry}>
        {t(lang, 'offlineRetry')}
      </button>
    </div>
  )
}
