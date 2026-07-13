import './lib/polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import AppErrorBoundary from './components/AppErrorBoundary'
import { checkCapabilities, renderCapabilityScreen } from './lib/capabilities'

const rootEl = document.getElementById('root')!

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
  createRoot(rootEl).render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>
  )
}
