/**
 * Ранняя проверка возможностей движка ДО основного UI (P2).
 *
 * @vitejs/plugin-legacy транспилирует только JS-синтаксис и добавляет core-js
 * полифиллы встроенных объектов. Он НЕ полифиллит:
 *   • CSS (Grid и logical properties) — их поддержка зависит от
 *     версии WebView, а не от бандла;
 *   • платформенные Web API (Proxy, IntersectionObserver и пр.).
 * На очень старом WebView (Chrome < ~57) POS может «поехать» вёрсткой или
 * упасть на отсутствующем API. Лучше показать честный диагностический экран
 * с версией движка и инструкцией обновления, чем сломанную кассу.
 *
 * Замечание о честности: «поддержка Grid» здесь — эвристика через
 * CSS.supports, а не гарантия попиксельной корректности. Мы НЕ заявляем
 * полную Chrome-52 совместимость: минимум транспилируется, но старый движок
 * платит налог. Порог подобран так, чтобы пропустить рабочие движки и
 * отсечь заведомо непригодные.
 */

export interface CapabilityReport {
  ok: boolean
  missing: string[]
  /** Некритичные деградации, для которых в CSS есть fallback. */
  warnings: string[]
  chromeMajor: number | null
}

/** Мажор Chrome/Chromium из UA (версия WebView в APK). null — не определить. */
export function chromeMajor(): number | null {
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent)
  return m ? parseInt(m[1], 10) : null
}

function cssSupports(prop: string, value: string): boolean {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports(prop, value)
  } catch {
    return false
  }
}

/**
 * Проверить критичные для горячего кассового потока возможности.
 * Критичные (блокируют запуск): Grid, CSS-переменные, Proxy, Promise.
 * Flex-gap не блокирует запуск: index.css эмулирует его отступами для старых
 * Chromium. Это не попиксельная замена, поэтому оставляем warning.
 * Логические свойства НЕ критичны — под них есть CSS-фолбэк (см. index.css),
 * но их отсутствие фиксируем в отчёте для диагностики.
 */
export function checkCapabilities(): CapabilityReport {
  const missing: string[] = []
  const warnings: string[] = []
  const major = chromeMajor()

  // ── CSS ──
  if (!cssSupports('display', 'grid')) missing.push('CSS Grid')
  // CSS.supports('gap') на Chrome 57–83 может означать только Grid gap,
  // поэтому для Chromium используем известную границу flex-gap (84).
  const flexGap = major !== null ? major >= 84 : cssSupports('gap', '1px')
  if (!flexGap) warnings.push('flex gap fallback')
  if (!cssSupports('--x', '0')) missing.push('CSS variables')

  // ── Runtime API (то, что core-js не полифиллит гарантированно) ──
  if (typeof Promise === 'undefined') missing.push('Promise')
  if (typeof Proxy === 'undefined') missing.push('Proxy') // Zustand/React используют
  if (typeof Map === 'undefined' || typeof Set === 'undefined') missing.push('Map/Set')
  if (typeof fetch === 'undefined') missing.push('fetch')

  return { ok: missing.length === 0, missing, warnings, chromeMajor: major }
}

/**
 * Отрисовать диагностический экран (голый DOM, без React — React мог и не
 * подняться на этом движке). he/ru читаем из того же persist-ключа языка.
 */
export function renderCapabilityScreen(root: HTMLElement, report: CapabilityReport): void {
  let lang: 'ru' | 'he' = 'he'
  try {
    const raw = localStorage.getItem('kassa-lang')
    const v = raw ? JSON.parse(raw)?.state?.lang : null
    if (v === 'ru' || v === 'he') lang = v
  } catch { /* ignore */ }
  const isRtl = lang === 'he'

  const version = report.chromeMajor ? `Chrome ${report.chromeMajor}` : 'неизвестно'
  const T = {
    ru: {
      title: 'Браузер устарел',
      body: 'Встроенный движок этого устройства слишком старый для кассы. Обновите системный WebView (Chrome) или используйте более новое устройство.',
      engine: 'Движок',
      missing: 'Не хватает',
      how: 'Как обновить: Play Маркет → «Android System WebView» и «Chrome» → Обновить. Затем перезапустите кассу.',
    },
    he: {
      title: 'הדפדפן מיושן',
      body: 'מנוע הדפדפן המובנה של המכשיר ישן מדי עבור הקופה. עדכנו את ה-WebView (Chrome) של המערכת או השתמשו במכשיר חדש יותר.',
      engine: 'מנוע',
      missing: 'חסר',
      how: 'איך לעדכן: Play Store → «Android System WebView» ו-«Chrome» → עדכון. לאחר מכן הפעילו מחדש את הקופה.',
    },
  }[lang]

  root.setAttribute('dir', isRtl ? 'rtl' : 'ltr')
  root.innerHTML = `
    <div style="min-height:100vh;background:#eceef1;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,Arial,sans-serif;text-align:center;">
      <div style="max-width:420px;width:100%;background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.1);padding:32px;">
        <p style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;">${T.title}</p>
        <p style="font-size:14px;color:#6b7280;margin:0 0 16px;line-height:1.5;">${T.body}</p>
        <p style="font-size:13px;color:#374151;margin:0 0 4px;"><b>${T.engine}:</b> ${version}</p>
        <p style="font-size:13px;color:#374151;margin:0 0 16px;"><b>${T.missing}:</b> ${report.missing.join(', ')}</p>
        <p style="font-size:13px;color:#6b7280;margin:0;line-height:1.5;">${T.how}</p>
      </div>
    </div>`
}
