/**
 * Разовая перезаливка уже загруженных фото товаров: скачивает каждый
 * файл из бакета menu-images, ужимает через sharp (JPEG, ≤1000px) и
 * кладёт ОБРАТНО на то же имя. image_url в товарах не меняется —
 * трогать таблицы не нужно.
 *
 * Нужен service_role: скрипт ходит в чужие org-папки и перезаписывает
 * файлы, обычный anon-ключ этого не даст (RLS/Storage policies).
 *
 * Запуск (ключ НЕ коммитим — только через переменные окружения):
 *   SUPABASE_URL="https://qgmnxrgtlpyqglwqmsej.supabase.co" \
 *   SUPABASE_SERVICE_ROLE="<service_role_key>" \
 *   node scripts/compress-existing-images.mjs
 *
 * Идемпотентно: уже сжатые файлы (мельче порога и так JPEG) пропускает,
 * можно гонять повторно.
 */
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE
const BUCKET = 'menu-images'
const MAX_SIDE = 1000
const QUALITY = 82
// Ниже этого размера файл уже лёгкий — не трогаем (если он и так JPEG)
const SKIP_UNDER_BYTES = 120 * 1024

if (!URL || !KEY) {
  console.error('Задай SUPABASE_URL и SUPABASE_SERVICE_ROLE в окружении. См. шапку файла.')
  process.exit(1)
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } })

/** Рекурсивно собрать все файлы бакета (папки = org_id/…) */
async function listAll(prefix = '') {
  const out = []
  const { data, error } = await sb.storage.from(BUCKET).list(prefix, { limit: 1000 })
  if (error) throw new Error(`list ${prefix}: ${error.message}`)
  for (const entry of data) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    // У «папки» нет id/metadata — уходим внутрь
    if (entry.id === null || entry.metadata === null) {
      out.push(...(await listAll(path)))
    } else {
      out.push({ path, size: entry.metadata?.size ?? 0 })
    }
  }
  return out
}

async function run() {
  console.log('Сканирую бакет…')
  const files = await listAll()
  console.log(`Найдено файлов: ${files.length}`)

  let done = 0, skipped = 0, saved = 0, failed = 0
  for (const f of files) {
    const isJpeg = /\.jpe?g$/i.test(f.path)
    if (isJpeg && f.size > 0 && f.size < SKIP_UNDER_BYTES) { skipped++; continue }

    try {
      const { data, error } = await sb.storage.from(BUCKET).download(f.path)
      if (error) throw new Error(error.message)
      const input = Buffer.from(await data.arrayBuffer())

      const output = await sharp(input)
        .rotate() // применить EXIF-ориентацию до ресайза
        .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }) // прозрачность → белый (JPEG без альфы)
        .jpeg({ quality: QUALITY })
        .toBuffer()

      if (output.length >= input.length) { skipped++; continue } // не выиграли — не портим

      const { error: upErr } = await sb.storage.from(BUCKET).upload(f.path, output, {
        upsert: true,
        contentType: 'image/jpeg',
        cacheControl: '31536000',
      })
      if (upErr) throw new Error(upErr.message)

      saved += input.length - output.length
      done++
      const kb = (n) => (n / 1024).toFixed(0)
      console.log(`✓ ${f.path}: ${kb(input.length)}КБ → ${kb(output.length)}КБ`)
    } catch (e) {
      failed++
      console.warn(`✗ ${f.path}: ${e.message}`)
    }
  }

  console.log(
    `\nГотово. Сжато: ${done}, пропущено: ${skipped}, ошибок: ${failed}. ` +
    `Экономия: ${(saved / 1024 / 1024).toFixed(1)} МБ.`
  )
}

run().catch((e) => { console.error(e); process.exit(1) })
