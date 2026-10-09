import { Component, type ReactNode } from 'react'
import { bootLang } from '../lib/bootLang'

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


export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[AppErrorBoundary]', error)
    // Сигнал телеметрии событием, без импорта модулей (они могут быть причиной краша)
    try {
      window.dispatchEvent(new CustomEvent('kassa:client-error', {
        detail: { source: 'react', message: `AppErrorBoundary: ${error.message}`, stack: error.stack },
      }))
    } catch { /* ignore */ }
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

    const lang = bootLang()
    const isRtl = lang === 'he'
    const { title, hint, btn } = {
      he: {
        title: 'הקופה נתקלה בתקלה',
        hint: 'איפוס טוען מחדש את הקופה. הזמנות שלא נשלחו נשמרות.',
        btn: 'איפוס וטעינה מחדש',
      },
      en: {
        title: 'The register ran into a problem',
        hint: 'A reset reloads the register. Unsent orders are kept.',
        btn: 'Reset and reload',
      },
      ru: {
        title: 'Касса столкнулась со сбоем',
        hint: 'Сброс перезагрузит кассу. Неотправленные заказы сохранятся.',
        btn: 'Сбросить и перезагрузить',
      },
    }[lang]

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
