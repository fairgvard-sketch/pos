import './lib/polyfills'
import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import AppErrorBoundary from './components/AppErrorBoundary'
import { checkCapabilities, renderCapabilityScreen } from './lib/capabilities'

const rootEl = document.getElementById('root')!
const isPublicSurface = import.meta.env.VITE_APP_SURFACE === 'menu'

function mountApp(App: ComponentType) {
  createRoot(rootEl).render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>
  )
}

// Ранний гейт совместимости (P2): на слишком старом WebView без Grid/Proxy
// показываем диагностический экран вместо сломанного POS. Для flex-gap есть
// CSS fallback. Проверка до монтирования React — он мог бы и не подняться.
const caps = checkCapabilities()
if (caps.warnings.includes('flex gap fallback')) {
  document.documentElement.classList.add('no-flex-gap')
}
if (!caps.ok) {
  renderCapabilityScreen(rootEl, caps)
} else {
  // Один репозиторий, две независимые поверхности. В menu-сборке Rollup
  // удаляет недостижимую ветку POS, поэтому гостю не отдаются кассовые
  // маршруты и не запускаются device sync / offline queue / auth.
  const appModule = isPublicSurface ? import('./PublicApp') : import('./App')
  void appModule.then(({ default: App }) => mountApp(App))
}
