#!/usr/bin/env node
/**
 * Guard project-ref (P10): перед `supabase db push` / `functions deploy`
 * сверяет, что целевой проект — именно qgmnxrgtlpyqglwqmsej (был инцидент:
 * применяли миграции не в тот проект).
 *
 * Проверяет два источника и требует их совпадения с ожидаемым ref:
 *   1. VITE_SUPABASE_URL из .env (хост вида <ref>.supabase.co);
 *   2. привязанный проект Supabase CLI (supabase/.temp/project-ref, если есть).
 *
 * Использование:
 *   node scripts/check-project-ref.mjs
 *   # затем, только при exit 0:
 *   supabase db push
 *
 * Или обёрткой (см. npm-скрипты db:push / functions:deploy).
 * Ненулевой код выхода → останавливает деплой.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const EXPECTED = 'qgmnxrgtlpyqglwqmsej'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(msg) {
  console.error(`\x1b[31m✗ project-ref guard: ${msg}\x1b[0m`)
  process.exit(1)
}

// 1. .env → VITE_SUPABASE_URL
let envRef = null
const envPath = join(root, '.env')
if (existsSync(envPath)) {
  const m = /VITE_SUPABASE_URL\s*=\s*https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(readFileSync(envPath, 'utf8'))
  if (m) envRef = m[1]
}
if (!envRef) fail('не найден VITE_SUPABASE_URL (<ref>.supabase.co) в .env')
if (envRef !== EXPECTED) {
  fail(`.env указывает на проект "${envRef}", ожидался "${EXPECTED}". Деплой остановлен.`)
}

// 2. Supabase CLI linked ref (если проект привязан)
const linkedPath = join(root, 'supabase', '.temp', 'project-ref')
if (existsSync(linkedPath)) {
  const linked = readFileSync(linkedPath, 'utf8').trim()
  if (linked && linked !== EXPECTED) {
    fail(`Supabase CLI привязан к "${linked}", ожидался "${EXPECTED}". Выполните: supabase link --project-ref ${EXPECTED}`)
  }
}

console.log(`\x1b[32m✓ project-ref = ${EXPECTED} — можно применять миграции/функции\x1b[0m`)
