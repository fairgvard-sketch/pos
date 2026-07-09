/**
 * Сжатие фото товара ПЕРЕД загрузкой в Storage.
 *
 * Зачем: фото с телефона — 3-5 МБ, 4000px. На плитке 140px это лишние
 * мегабайты по сети и тяжёлое декодирование на слабом WebView T2 (Sunmi,
 * Android 7.1). Ужимаем до разумного размера ещё в браузере.
 *
 * Формат — JPEG, не WebP: canvas.toBlob('image/webp') на Chrome ~52
 * (WebView Android 7.1) ненадёжен, а JPEG-энкодинг есть везде. Выигрыш
 * в весе на фото — минимальный.
 */

const MAX_SIDE = 1000 // px по большей стороне — с запасом для hero-превью
const QUALITY = 0.82

/**
 * Уменьшает картинку до MAX_SIDE по большей стороне и жмёт в JPEG.
 * Не-картинки и SVG/GIF возвращает как есть (canvas их испортит).
 * При любой ошибке декодирования — тоже отдаёт оригинал (лучше тяжёлое
 * фото, чем сорванная загрузка).
 */
export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') {
    return file
  }

  let bitmap: ImageBitmap | HTMLImageElement
  try {
    bitmap = await loadBitmap(file)
  } catch {
    return file
  }

  const { width, height } = bitmap
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  // Уже мелкая и уже JPEG — не гоняем через canvas зря
  if (scale === 1 && file.type === 'image/jpeg') {
    close(bitmap)
    return file
  }

  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) { close(bitmap); return file }
  // Белая подложка: у прозрачных PNG иначе будет чёрный фон после JPEG
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  close(bitmap)

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', QUALITY)
  )
  if (!blob || blob.size >= file.size) return file // не раздули — оставляем оригинал

  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
  return new File([blob], name, { type: 'image/jpeg' })
}

/** createImageBitmap там, где есть (быстрее); иначе — <img> через objectURL */
async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file)
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('decode failed'))
      img.src = url
    })
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

function close(b: ImageBitmap | HTMLImageElement) {
  if ('close' in b && typeof b.close === 'function') b.close()
}
