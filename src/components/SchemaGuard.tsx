import { useQuery } from '@tanstack/react-query'
import { checkSchemaVersion, MIN_SCHEMA_VERSION } from '../lib/schemaVersion'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'

/**
 * Экран «Требуется обновление базы данных»: если БД отстаёт от фронта
 * (миграции не накатаны), касса останавливается с диагностикой вместо
 * тихо пустого каталога. Ответ 'unknown' (офлайн, сбой сети) не блокирует —
 * POS продолжает работать по локальному кэшу.
 */
export default function SchemaGuard({ children }: { children: React.ReactNode }) {
  const lang = useLangStore((s) => s.lang)
  const { data, refetch, isRefetching } = useQuery({
    queryKey: ['schema_version'],
    queryFn: checkSchemaVersion,
    // Одна проверка на запуск приложения; «Повторить» делает refetch вручную
    staleTime: Infinity,
    gcTime: Infinity,
  })

  if (data?.status !== 'outdated') return <>{children}</>

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-gray-900 mt-4">{t(lang, 'schemaOutdatedTitle')}</h1>
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">{t(lang, 'schemaOutdatedHint')}</p>
        <p className="text-sm text-gray-500 mt-3">
          {t(lang, 'schemaVersions')
            .replace('{db}', String(data.version))
            .replace('{app}', String(MIN_SCHEMA_VERSION))}
        </p>
        <button className="btn-secondary mt-6" onClick={() => refetch()} disabled={isRefetching}>
          {t(lang, 'offlineRetry')}
        </button>
      </div>
    </div>
  )
}
