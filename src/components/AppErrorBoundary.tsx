import { Component, type ReactNode } from 'react'

/**
 * Корневой ErrorBoundary — оборачивает ВСЁ дерево в main.tsx, включая
 * провайдеры (PersistQueryClientProvider, BrowserRouter). RouteErrorBoundary
 * живёт ВНУТРИ роутера и ловит краши страниц; но если рухнет сам провайдер
 * (например, порченый localStorage-кэш при гидратации PersistQueryClient или
 * несовместимый API в старом WebView T2) — роутер не смонтируется, и без
 * внешнего бойлера будет голый белый экран.
 *
 * Самодостаточен: классовый компонент, ноль зависимостей от сторов/хуков/
 * QueryClient (они могут быть причиной краша). Язык читаем из persist-ключа
 * напрямую. Кнопка «Сбросить» чистит потенциально ядовитый кэш и
 * перезагружает — финансовый outbox НЕ трогаем (см. список ниже).
 */
type Props = { children: ReactNode }
type State = { error: Error | null }

/** Ключи, которые безопасно снести при аварийном сбросе. НЕ включает
 *  kassa-outbox (неотправленные финансовые операции) и сессию устройства. */
const SAFE_TO_CLEAR = ['kassa-query-cache']

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

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[AppErrorBoundary]', error)
  }

  private hardReload = () => {
    try {
      for (const k of SAFE_TO_CLEAR) localStorage.removeItem(k)
    } catch { /* ignore */ }
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const isRtl = currentLang() === 'he'
    const title = isRtl ? 'הקופה נתקלה בתקלה' : 'Касса столкнулась со сбоем'
    const hint = isRtl
      ? 'איפוס טוען מחדש את הקופה. הזמנות שלא נשלחו נשמרות.'
      : 'Сброс перезагрузит кассу. Неотправленные заказы сохранятся.'
    const btn = isRtl ? 'איפוס וטעינה מחדש' : 'Сбросить и перезагрузить'

    return (
      <div
        dir={isRtl ? 'rtl' : 'ltr'}
        className="h-screen bg-[#eceef1] flex flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <div className="max-w-sm w-full bg-white rounded-2xl shadow-sm p-8">
          <p className="text-lg font-black text-gray-900">{title}</p>
          <p className="text-sm text-gray-500 mt-2">{hint}</p>
          <button
            className="w-full h-12 mt-6 rounded-xl bg-gray-900 text-white font-bold active:scale-[0.97] transition-transform"
            onClick={this.hardReload}
          >
            {btn}
          </button>
        </div>
      </div>
    )
  }
}
