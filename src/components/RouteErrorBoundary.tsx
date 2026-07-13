import { Component, type ReactNode } from 'react'

/**
 * Ловит краши lazy-роутов (и любой runtime-краш внутри страницы), чтобы
 * не рушить всё дерево до корня — раньше это давало пустой белый экран.
 *
 * Главный кейс — «Failed to fetch dynamically imported module» после
 * деплоя (устаревший хеш чанка). lazyWithRetry уже делает один reload;
 * если и он не помог, показываем экран «обновить» вместо белого.
 *
 * Самодостаточен (без i18n-хелпера/сторов через хуки): классовый компонент,
 * язык читаем из persist-ключа напрямую — он должен работать даже когда
 * что-то в приложении сломано.
 */
type Props = { children: ReactNode }
type State = { error: Error | null }

function isChunkError(err: Error): boolean {
  const m = `${err?.name} ${err?.message}`
  return (
    /Failed to fetch dynamically imported module/i.test(m) ||
    /Importing a module script failed/i.test(m) ||
    /error loading dynamically imported module/i.test(m) ||
    /ChunkLoadError/i.test(m)
  )
}

function currentLang(): 'ru' | 'he' {
  try {
    const raw = localStorage.getItem('kassa-lang')
    if (raw) {
      const v = JSON.parse(raw)?.state?.lang
      if (v === 'he' || v === 'ru') return v
    }
  } catch { /* localStorage может быть недоступен */ }
  return 'he'
}

export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // Виден в консоли для диагностики; в проде можно завести отправку в лог
    console.error('[RouteErrorBoundary]', error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const isRtl = currentLang() === 'he'
    const chunk = isChunkError(error)
    const title = chunk
      ? (isRtl ? 'עדכון זמין' : 'Доступно обновление')
      : (isRtl ? 'משהו השתבש' : 'Что-то пошло не так')
    const hint = chunk
      ? (isRtl ? 'טוענים גרסה חדשה של הקופה' : 'Загружаем новую версию кассы')
      : (isRtl ? 'נסו לרענן את הדף' : 'Попробуйте обновить страницу')
    const btn = isRtl ? 'רענון' : 'Обновить'

    return (
      <div
        dir={isRtl ? 'rtl' : 'ltr'}
        className="h-screen bg-[#eceef1] flex flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <div className="card max-w-sm w-full p-8">
          <p className="text-lg font-black text-gray-900">{title}</p>
          <p className="text-sm text-gray-500 mt-2">{hint}</p>
          <button
            className="btn-primary w-full h-12 mt-6"
            onClick={() => window.location.reload()}
          >
            {btn}
          </button>
        </div>
      </div>
    )
  }
}
