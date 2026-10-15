#!/usr/bin/env node
/**
 * Переводы QR-меню (Kassa 184) из словаря в каталог точки.
 *
 * Словарь — scripts/menu-translations/<заведение>.json, ключ — базовое
 * ивритское название записи. Логика плана — plan.mjs (там же правила:
 * ручной перевод владельца не перезаписывается, устаревшее описание не
 * переводится).
 *
 * Запуск:
 *   node scripts/apply-menu-translations.mjs scripts/menu-translations/bulochka.json --preview-public
 *       сверка с публичным меню (только видимые гостю позиции), без токена
 *   SUPABASE_ACCESS_TOKEN=... node scripts/apply-menu-translations.mjs <словарь>
 *       dry-run по всему каталогу точки (Management API, только чтение)
 *   SUPABASE_ACCESS_TOKEN=... node scripts/apply-menu-translations.mjs <словарь> --apply [--enable-languages] [--overwrite]
 *       запись одной транзакцией; --enable-languages включает гостю en и ru
 *
 * Требует миграцию 184 на проде. Повторный запуск безопасен: уже
 * переведённое попадает в «без изменений».
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildSql, planTranslations } from './menu-translations/plan.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const KASSA_REF = 'qgmnxrgtlpyqglwqmsej'
const args = process.argv.slice(2)
const file = args.find((arg) => !arg.startsWith('--'))
const APPLY = args.includes('--apply')
const PREVIEW = args.includes('--preview-public')
const OVERWRITE = args.includes('--overwrite')
const ENABLE = args.includes('--enable-languages')

if (!file) {
  console.error('Укажите словарь: node scripts/apply-menu-translations.mjs scripts/menu-translations/bulochka.json')
  process.exit(1)
}
const dict = JSON.parse(readFileSync(file, 'utf8'))
const LOCATION_ID = dict.location_id
if (!/^[0-9a-f-]{36}$/i.test(LOCATION_ID ?? '')) {
  console.error('В словаре нет location_id точки')
  process.exit(1)
}

function env(name) {
  const text = readFileSync(join(root, '.env'), 'utf8')
  return new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim()
}

/** Публичное меню: то, что гость видит прямо сейчас (без скрытых позиций). */
async function publicCatalog() {
  const url = env('VITE_SUPABASE_URL')
  const key = env('VITE_SUPABASE_ANON_KEY')
  const res = await fetch(`${url}/functions/v1/public-menu?loc=${LOCATION_ID}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  if (!res.ok) throw new Error(`public-menu: HTTP ${res.status}`)
  const menu = await res.json()
  const items = menu.categories.flatMap((c) => c.items)
  const groups = new Map()
  for (const item of items) for (const g of item.modifier_groups) groups.set(g.id, g)
  // Старая edge function переводов не отдаёт — считаем их пустыми
  const tr = (row) => row.translations ?? {}
  return {
    orgId: null,
    catalog: {
      categories: menu.categories.map((c) => ({ id: c.id, name: c.name, translations: tr(c) })),
      items: items.map((i) => ({ id: i.id, name: i.name, description: i.description, translations: tr(i) })),
      variants: items.flatMap((i) => i.variants.map((v) => ({ id: v.id, name: v.name, translations: tr(v) }))),
      groups: [...groups.values()].map((g) => ({ id: g.id, name: g.name, translations: tr(g) })),
      modifiers: [...groups.values()].flatMap((g) => g.modifiers.map((m) => ({ id: m.id, name: m.name, translations: tr(m) }))),
    },
  }
}

async function sql(query) {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  if (!token) {
    console.error('Нужен SUPABASE_ACCESS_TOKEN (токен Management API / supabase login)')
    process.exit(1)
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${KASSA_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`SQL HTTP ${res.status}: ${body.slice(0, 500)}`)
  return JSON.parse(body)
}

/** Весь каталог точки, включая скрытые позиции и неактивные категории. */
async function fullCatalog() {
  const loc = LOCATION_ID.replace(/'/g, '')
  const [row] = await sql(`
    WITH cats AS (SELECT * FROM menu_categories WHERE location_id = '${loc}'),
         its AS (SELECT mi.* FROM menu_items mi JOIN cats c ON c.id = mi.category_id),
         grps AS (SELECT DISTINCT g.* FROM modifier_groups g
                  JOIN menu_item_modifier_groups l ON l.group_id = g.id
                  JOIN its i ON i.id = l.item_id)
    SELECT json_build_object(
      'org_id', (SELECT org_id FROM locations WHERE id = '${loc}'),
      'categories', (SELECT COALESCE(json_agg(json_build_object('id', id, 'name', name, 'translations', translations)), '[]') FROM cats),
      'items', (SELECT COALESCE(json_agg(json_build_object('id', id, 'name', name, 'description', description, 'translations', translations)), '[]') FROM its),
      'variants', (SELECT COALESCE(json_agg(json_build_object('id', v.id, 'name', v.name, 'translations', v.translations)), '[]')
                   FROM item_variants v JOIN its i ON i.id = v.item_id),
      'groups', (SELECT COALESCE(json_agg(json_build_object('id', id, 'name', name, 'translations', translations)), '[]') FROM grps),
      'modifiers', (SELECT COALESCE(json_agg(json_build_object('id', m.id, 'name', m.name, 'translations', m.translations)), '[]')
                    FROM modifiers m JOIN grps g ON g.id = m.group_id)
    ) AS st`)
  const st = row.st
  return { orgId: st.org_id, catalog: st }
}

if (!PREVIEW) {
  // Тот же guard, что у db:push: .env и привязанный CLI обязаны смотреть в прод-проект
  execFileSync(process.execPath, [join(root, 'scripts', 'check-project-ref.mjs')], { stdio: 'inherit' })
}

const { orgId, catalog } = PREVIEW ? await publicCatalog() : await fullCatalog()
if (!PREVIEW && !orgId) {
  console.error(`Точка ${LOCATION_ID} не найдена`)
  process.exit(1)
}
const plan = planTranslations(catalog, dict, { overwrite: OVERWRITE })

const count = (kind) => (catalog[kind] ?? []).length
console.log(`Каталог: ${count('categories')} категорий, ${count('items')} позиций, ${count('variants')} размеров, `
  + `${count('groups')} групп, ${count('modifiers')} добавок${PREVIEW ? ' (только видимое гостю)' : ''}`)
console.log(`Изменится: ${plan.updates.length}, без изменений: ${plan.unchanged}, нет в словаре: ${plan.unmatched.length}`)
for (const u of plan.updates) {
  const after = ['en', 'ru'].map((lang) => u.after[lang]?.name).filter(Boolean).join(' / ')
  console.log(`  ~ ${u.kind.padEnd(10)} ${u.name} → ${after}`)
}
if (plan.unmatched.length) {
  console.log('\nНет в словаре (останутся на иврите):')
  for (const u of plan.unmatched) console.log(`  ? ${u.kind.padEnd(10)} ${u.name}`)
}
if (plan.staleDescriptions.length) {
  console.log('\nОписание в каталоге изменилось — переведено только название:')
  for (const s of plan.staleDescriptions) console.log(`  ! ${s.name}: ${s.current ?? '(пусто)'}`)
}

if (!APPLY) {
  console.log(`\nDry-run. Записать: добавьте --apply${ENABLE ? '' : ' (и --enable-languages, чтобы включить гостю en и ru)'}`)
  process.exit(0)
}
if (PREVIEW) {
  console.error('--apply не работает с --preview-public: публичное меню не содержит скрытых позиций и org_id')
  process.exit(1)
}

await sql(buildSql(plan, {
  orgId,
  locationId: LOCATION_ID,
  enableLanguages: ENABLE ? ['en', 'ru'] : null,
}))
console.log(`\nЗаписано: ${plan.updates.length} строк${ENABLE ? ', языки гостя: he, en, ru' : ''}`)
