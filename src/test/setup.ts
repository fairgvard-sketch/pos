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
