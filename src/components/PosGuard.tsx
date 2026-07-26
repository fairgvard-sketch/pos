import { lazy, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { checkPosEntitlement } from '../lib/posEntitlement'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'

// 'missing' возможен только при живом ответе сервера — экран грузим лениво,
// стартовый bundle горячего потока не растёт.
const GuardScreen = lazy(() => import('./GuardScreen'))

/**
 * Экран «ANGLE POS не активирован»: организация без действующего продукта
 * `pos` (ожидает активации оператором или приостановлена) видит явное
 * состояние вместо кассы, у которой молча падают все мутации
 * module_disabled. Данные организации сохранены: активация возвращает
 * доступ без миграции. 'unknown' (офлайн/сбой/старая база) не блокирует.
 */
export default function PosGuard({ children }: { children: React.ReactNode }) {
  const lang = useLangStore((s) => s.lang)
  const { data, refetch, isRefetching } = useQuery({
    queryKey: ['pos_entitlement'],
    queryFn: checkPosEntitlement,
    // Одна проверка на запуск приложения; «Повторить» делает refetch вручную
    staleTime: Infinity,
    gcTime: Infinity,
  })

  if (data !== 'missing') return <>{children}</>

  return (
    <Suspense fallback={null}>
    <GuardScreen
      iconClass="bg-gray-200 text-gray-600"
      icon={
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M8 21h8M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      }
      title={t(lang, 'posInactiveTitle')}
      hint={t(lang, 'posInactiveHint')}
      retryLabel={t(lang, 'offlineRetry')}
      onRetry={() => refetch()}
      retrying={isRefetching}
    />
    </Suspense>
  )
}
