/**
 * Canvas → ESC/POS растр (GS v 0) → rawbt: URL.
 *
 * Печать чека на встроенном термопринтере Sunmi через приложение RawBT
 * (мост: браузер не видит принтер Sunmi как системный, а RawBT умеет
 * печатать на него напрямую). Чек шлём КАРТИНКОЙ — это снимает вопросы
 * иврита в ESC/POS (кодировка CP862, RTL-порядок): печатается 1:1 как
 * отрисовано на canvas.
 */

/** ESC/POS байты картинки в base64 — для моста APK (KassaAndroid) и RawBT */
export function canvasToEscposBase64(canvas: HTMLCanvasElement): string {
  const bytes = canvasToEscposRaster(canvas)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** Собрать rawbt:-ссылку с ESC/POS байтами картинки (переход по ней откроет RawBT) */
export function canvasToRawbtUrl(canvas: HTMLCanvasElement): string {
  return 'rawbt:base64,' + canvasToEscposBase64(canvas)
}

/**
 * Тихая печать canvas (без диалогов): мост APK → RawBT (если разрешён) → false.
 * Для автопечати (чек после оплаты, тикет на кухню): если тихого пути
 * нет — НЕ открываем браузерный диалог, просто возвращаем false.
 * allowRawbt — только когда способ печати кассы = 'rawbt' (иначе на
 * устройствах без RawBT дёргали бы несуществующую схему).
 */
export function printCanvasSilently(canvas: HTMLCanvasElement, allowRawbt: boolean): boolean {
  const bridge = window.KassaAndroid
  if (bridge?.isAvailable()) {
    return bridge.printBase64(canvasToEscposBase64(canvas))
  }
  if (allowRawbt) {
    window.location.href = canvasToRawbtUrl(canvas)
    return true
  }
  return false
}

/** Canvas → ESC/POS: init, растр GS v 0 (1 бит/пиксель), прогон, отрез */
function canvasToEscposRaster(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d')!
  const { width, height } = canvas
  const img = ctx.getImageData(0, 0, width, height).data

  const bytesPerRow = Math.ceil(width / 8)
  const raster = new Uint8Array(bytesPerRow * height)

  // Порог яркости: тёмные пиксели → чёрные точки
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const lum = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2]
      if (img[i + 3] > 128 && lum < 160) {
        raster[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }

  const header = [
    0x1b, 0x40, // ESC @ — init
    0x1d, 0x76, 0x30, 0x00, // GS v 0, normal
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
  ]
  const footer = [
    0x1b, 0x64, 0x04, // ESC d 4 — прогон 4 строки
    0x1d, 0x56, 0x42, 0x00, // GS V B 0 — частичный отрез (если резак есть)
  ]

  const out = new Uint8Array(header.length + raster.length + footer.length)
  out.set(header, 0)
  out.set(raster, header.length)
  out.set(footer, header.length + raster.length)
  return out
}
