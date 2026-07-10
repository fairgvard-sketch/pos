import { useNetStore } from '../lib/offline/net'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'

/**
 * Плашка «нет сети» для админских экранов (меню, настройки): их мутации
 * не входят в офлайн-очередь — правки без сети просто не сохранятся.
 */
export default function OfflineBanner() {
  const online = useNetStore((s) => s.online)
  const lang = useLangStore((s) => s.lang)
  if (online) return null
  return (
    <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700">
      {t(lang, 'offlineAdminBanner')}
    </div>
  )
}
