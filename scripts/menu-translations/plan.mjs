/**
 * План переводов QR-меню (Kassa 184) из словаря по базовым названиям.
 *
 * Чистая функция: на входе каталог точки и словарь, на выходе — какие
 * строки и как поменяются. Сети и базы здесь нет, поэтому план одинаково
 * считается для dry-run, для --apply и в тестах.
 *
 * Правила:
 *   • ключ словаря — базовое название записи, сравнение без учёта
 *     пробелов, вида апострофа/гереша и регистра латиницы;
 *   • уже заполненный владельцем перевод не перезаписывается (если не
 *     передан overwrite) — ручная правка в кабинете важнее словаря;
 *   • перевод описания действует, только пока ивритский оригинал совпадает
 *     с тем, с которого переводили (source): изменённое описание получает
 *     перевод названия, а описание попадает в отчёт;
 *   • языки, которых нет в словаре (например, he), сохраняются как есть.
 */

const LANGS = ['en', 'ru']

export function normName(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[’'׳`´]/g, "'")
    .replace(/[״"“”„«»]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function index(section) {
  const map = new Map()
  for (const [key, value] of Object.entries(section ?? {})) map.set(normName(key), value)
  return map
}

/** Название из словаря: строка ({en: 'Small'}) или объект ({en: {name}}) */
function entryName(entry, lang) {
  const value = entry?.[lang]
  return typeof value === 'string' ? value : value?.name
}

function sameJson(a, b) {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

/**
 * Новое значение translations для записи. fields — что даёт словарь:
 * { en: { name, description? }, ru: {...} }.
 */
function merge(current, fields, overwrite) {
  const next = { ...(current ?? {}) }
  for (const lang of LANGS) {
    const proposed = fields[lang]
    if (!proposed) continue
    const existing = { ...(next[lang] ?? {}) }
    for (const [field, text] of Object.entries(proposed)) {
      if (!text) continue
      if (!overwrite && typeof existing[field] === 'string' && existing[field].trim()) continue
      existing[field] = text
    }
    if (Object.keys(existing).length > 0) next[lang] = existing
  }
  return next
}

/**
 * catalog: { categories, items, variants, groups, modifiers } — массивы
 * строк базы ({ id, name, description?, translations }).
 * dict: разобранный словарь (scripts/menu-translations/*.json).
 */
export function planTranslations(catalog, dict, { overwrite = false } = {}) {
  const sections = {
    categories: index(dict.categories),
    items: index(dict.items),
    variants: index(dict.variants),
    groups: index(dict.groups),
    modifiers: index(dict.modifiers),
  }
  const tables = {
    categories: 'menu_categories',
    items: 'menu_items',
    variants: 'item_variants',
    groups: 'modifier_groups',
    modifiers: 'modifiers',
  }

  const updates = []
  const unmatched = []
  const staleDescriptions = []
  let unchanged = 0

  for (const kind of Object.keys(tables)) {
    for (const row of catalog[kind] ?? []) {
      const entry = sections[kind].get(normName(row.name))
      if (!entry) {
        unmatched.push({ kind, id: row.id, name: row.name })
        continue
      }
      const fields = {}
      for (const lang of LANGS) {
        const name = entryName(entry, lang)
        if (!name) continue
        fields[lang] = { name }
        const description = typeof entry[lang] === 'object' ? entry[lang]?.description : undefined
        if (kind === 'items' && description) {
          if (normName(entry.source) === normName(row.description)) {
            fields[lang].description = description
          } else if (lang === LANGS[0]) {
            staleDescriptions.push({ id: row.id, name: row.name, current: row.description ?? null })
          }
        }
      }
      const after = merge(row.translations, fields, overwrite)
      if (sameJson(after, row.translations)) {
        unchanged += 1
        continue
      }
      updates.push({ table: tables[kind], kind, id: row.id, name: row.name, before: row.translations ?? {}, after })
    }
  }

  return { updates, unmatched, staleDescriptions, unchanged }
}

/** Одна транзакция: переводы и (по флагу) языки гостя точки. */
export function buildSql(plan, { orgId, locationId, enableLanguages = null }) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
  const lines = ['BEGIN;']
  for (const update of plan.updates) {
    lines.push(
      `UPDATE ${update.table} SET translations = ${quote(JSON.stringify(update.after))}::jsonb `
      + `WHERE id = ${quote(update.id)} AND org_id = ${quote(orgId)};`,
    )
  }
  if (enableLanguages?.length) {
    lines.push(
      'UPDATE locations SET settings = jsonb_set(COALESCE(settings, \'{}\'::jsonb), \'{online_orders}\', '
      + `COALESCE(settings->'online_orders', '{}'::jsonb) || jsonb_build_object('languages', ${quote(JSON.stringify(enableLanguages))}::jsonb)) `
      + `WHERE id = ${quote(locationId)} AND org_id = ${quote(orgId)};`,
    )
  }
  lines.push('COMMIT;')
  return lines.join('\n')
}
