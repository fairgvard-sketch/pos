/**
 * Общий полноэкранный каркас блокирующих guard-состояний запуска
 * (SchemaGuard 081, PosGuard Phase 5): иконка, заголовок, пояснение и
 * ручной повтор. Вынесен, чтобы guard-экраны не дублировали разметку в
 * стартовом bundle.
 */
export default function GuardScreen({
  icon,
  iconClass,
  title,
  hint,
  extra,
  retryLabel,
  onRetry,
  retrying,
}: {
  icon: React.ReactNode
  iconClass: string
  title: string
  hint: string
  extra?: React.ReactNode
  retryLabel: string
  onRetry: () => void
  retrying: boolean
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-8">
      <div className="max-w-md text-center">
        <div className={`mx-auto w-12 h-12 rounded-2xl flex items-center justify-center ${iconClass}`}>
          {icon}
        </div>
        <h1 className="text-xl font-bold text-gray-900 mt-4">{title}</h1>
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">{hint}</p>
        {extra}
        <button className="btn-secondary mt-6" onClick={onRetry} disabled={retrying}>
          {retryLabel}
        </button>
      </div>
    </div>
  )
}
