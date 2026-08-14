import '@testing-library/jest-dom/vitest'

// crypto.randomUUID нужен outbox/enqueue тестам; jsdom его не всегда даёт.
// Тот же полифилл, что и на T2 (Chrome 52) — см. src/lib/polyfills.ts.
if (typeof globalThis.crypto === 'undefined') {
  // @ts-expect-error — тестовый шим
  globalThis.crypto = {}
}
if (typeof globalThis.crypto.randomUUID !== 'function') {
  let n = 0
  // Детерминированный UUID-подобный id — тестам важна уникальность, не энтропия
  globalThis.crypto.randomUUID = (() =>
    `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`) as Crypto['randomUUID']
}

// jsdom объявляет прокрутку, но бросает «Not implemented»: гостевые экраны
// возвращают страницу наверх при переходе и подводят выбранный слот в поле
// зрения. Прокрутка ничего не решает в логике — гасим её тихо.
if (typeof window !== 'undefined') {
  window.scrollTo = (() => {}) as typeof window.scrollTo
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {}
  }
}

// jsdom не реализует matchMedia, а её спрашивает переход между экранами
// гостевого сценария (prefers-reduced-motion). Без шима любой тест,
// нажимающий кнопку «дальше», падал бы на отсутствующей функции.
// Отвечаем «предпочтения нет» — то же, что у большинства устройств.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}
