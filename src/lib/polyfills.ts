/**
 * Полифиллы Web API под старый WebView (Sunmi T2 mini, Android 7.1 ~ Chrome 52-58).
 * Синтаксис/встроенные объекты закрывает @vitejs/plugin-legacy (core-js),
 * но Web API вроде crypto.randomUUID (Chrome 92+) — нет. Добираем вручную.
 * Импортируется ПЕРВЫМ в main.tsx.
 */

// crypto.randomUUID — на нём client_uuid заказов (идемпотентность) и имена файлов.
// Фолбэк: RFC 4122 v4 поверх getRandomValues (есть с Chrome 11).
if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  ;(crypto as Crypto).randomUUID = function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40 // версия 4
    b[8] = (b[8] & 0x3f) | 0x80 // вариант 10xx
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'))
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}` as `${string}-${string}-${string}-${string}-${string}`
  }
}

export {}
