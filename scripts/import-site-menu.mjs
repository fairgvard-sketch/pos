/**
 * Импорт меню сайта Bulochka (Firestore) в каталог кассы (Supabase) + карта
 * связки для онлайн-заказа с сайта.
 *
 * Что делает:
 *   1. Читает меню сайта (Firestore REST, публичное чтение) и каталог кассы
 *      (Management API SQL).
 *   2. Матчит позиции по ивритскому названию. Совпавшие НЕ трогает (каталог
 *      кассы — источник истины для продаж), несовпавшие создаёт: категория,
 *      товар, размеры (из группы «גודל» и/или двойной цены «₪11 / ₪14»),
 *      модификаторы из добавок сайта.
 *   3. Пишет карту siteDocId → kassa ids в bulweb2/kassa-map.json — её будет
 *      использовать чекаут сайта (POST public-order).
 *
 * Запуск:
 *   SUPABASE_ACCESS_TOKEN=... node scripts/import-site-menu.mjs          # dry-run (план)
 *   SUPABASE_ACCESS_TOKEN=... node scripts/import-site-menu.mjs --apply  # записать
 *
 * Идемпотентен: повторный запуск сматчит созданное ранее по имени и не
 * создаст дубликатов.
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
if (!TOKEN) {
  console.error('Нужен SUPABASE_ACCESS_TOKEN (токен Management API / supabase login)')
  process.exit(1)
}

const KASSA_REF = 'qgmnxrgtlpyqglwqmsej'
const LOCATION_ID = 'fe2eebf0-65e3-45b4-a81f-331359d71955' // Pinsker 29
const FIRE = 'https://firestore.googleapis.com/v1/projects/bulweb2/databases/(default)/documents'
const MAP_OUT = '/Users/enotov/Desktop/bulweb2/kassa-map.json'

// Категории сайта → канонические ивритские имена в кассе.
// Существующие в кассе (משקאות חמים, כריכים, מאפים, גלידה) сматчатся по имени.
const CATS = {
  'hot-drinks':  { he: 'משקאות חמים',    order: 0 },
  'cold-drinks': { he: 'משקאות קרים',    order: 10 },
  'sandwiches':  { he: 'כריכים',         order: 20 },
  'pastries':    { he: 'מאפים',          order: 30 },
  'filled':      { he: 'ממולאים',        order: 40 },
  'tartlets':    { he: 'טארטלטים',       order: 50 },
  'cakes':       { he: 'עוגות וקינוחים', order: 60 },
  'ice-cream':   { he: 'גלידה',          order: 70 },
  'alcohol':     { he: 'אלכוהול',        order: 80 },
  'friday':      { he: 'אפיית יום שישי', order: 90 },
}
const EXTRAS_GROUP_HE = 'תוספות' // общая группа для простых добавок (+помидор и т.п.)

// Ручные алиасы: имя на сайте → имя в кассе (когда одна и та же позиция
// названа по-разному). Дополнять по секции «в кассе без пары» в отчёте.
const ALIASES = {
  'שוקו חם עם מרשמלו': 'שוקו חם',
  'קרואסון שוקולד קטן': 'קרואסון שוקולד',
  'הטרופית': 'Тропическое',
  'היער השחור': 'Темный Лес',
}

// ── helpers ──────────────────────────────────────────────────

/** Firestore REST value → обычный JS */
function fireVal(v) {
  const [t, val] = Object.entries(v)[0]
  switch (t) {
    case 'integerValue': return Number(val)
    case 'doubleValue': return Number(val)
    case 'arrayValue': return (val.values ?? []).map(fireVal)
    case 'mapValue': return fireDoc(val.fields ?? {})
    default: return val // string/boolean/timestamp
  }
}
function fireDoc(fields) {
  const o = {}
  for (const [k, v] of Object.entries(fields)) o[k] = fireVal(v)
  return o
}

async function fireCollection(name) {
  const res = await fetch(`${FIRE}/${name}?pageSize=300`)
  if (!res.ok) throw new Error(`Firestore ${name}: HTTP ${res.status}`)
  const data = await res.json()
  return (data.documents ?? []).map((d) => ({ id: d.name.split('/').pop(), ...fireDoc(d.fields ?? {}) }))
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${KASSA_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`SQL HTTP ${res.status}: ${body.slice(0, 500)}`)
  return JSON.parse(body)
}

/** Нормализация ивритского названия для матчинга */
function norm(s) {
  return (s ?? '')
    .normalize('NFC')
    .replace(/[’'׳`´]/g, "'")
    .replace(/[״"]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** "₪11 / ₪14" → [1100, 1400] (агороты) */
function parsePrices(str) {
  return [...String(str ?? '').matchAll(/(\d+(?:[.,]\d+)?)/g)]
    .map((m) => Math.round(parseFloat(m[1].replace(',', '.')) * 100))
}

const esc = (s) => String(s).replace(/'/g, "''")

// ── main ─────────────────────────────────────────────────────

const [kassaState] = await sql(`
  SELECT json_build_object(
    'org_id', (SELECT org_id FROM locations WHERE id = '${LOCATION_ID}'),
    'categories', (SELECT COALESCE(json_agg(json_build_object('id', id, 'name', name, 'sort', sort_order)), '[]'::json)
                   FROM menu_categories WHERE location_id = '${LOCATION_ID}'),
    'items', (SELECT COALESCE(json_agg(json_build_object(
                'id', mi.id, 'name', mi.name, 'price', mi.price, 'category_id', mi.category_id,
                'variants', (SELECT COALESCE(json_agg(json_build_object('id', v.id, 'name', v.name, 'price', v.price) ORDER BY v.sort_order), '[]'::json)
                             FROM item_variants v WHERE v.item_id = mi.id),
                'group_ids', (SELECT COALESCE(json_agg(l.group_id), '[]'::json)
                              FROM menu_item_modifier_groups l WHERE l.item_id = mi.id)
              )), '[]'::json) FROM menu_items mi),
    'groups', (SELECT COALESCE(json_agg(json_build_object(
                'id', g.id, 'name', g.name,
                'modifiers', (SELECT COALESCE(json_agg(json_build_object('id', m.id, 'name', m.name, 'delta', m.price_delta) ORDER BY m.sort_order), '[]'::json)
                              FROM modifiers m WHERE m.group_id = g.id)
              )), '[]'::json) FROM modifier_groups g)
  ) AS st`)
const st = kassaState.st
const ORG = st.org_id

const kassaCatByName = new Map(st.categories.map((c) => [norm(c.name), c]))
const kassaItemByName = new Map(st.items.map((i) => [norm(i.name), i]))
const kassaGroupByName = new Map(st.groups.map((g) => [norm(g.name), g]))

const addons = await fireCollection('addons')
const addonById = new Map(addons.map((a) => [a.id, a]))

const siteCats = {}
for (const catId of Object.keys(CATS)) siteCats[catId] = await fireCollection(catId)

// ── план ─────────────────────────────────────────────────────

const plan = {
  newCategories: [], // {uuid, he, order}
  newGroups: [],     // {uuid, name, min, max, mods:[{uuid,name,delta}]}
  addGroupMods: [],  // {groupId, mods:[{uuid,name,delta}]} — в существующую группу
  newItems: [],      // {uuid, catRef, name, price, img, available, sort, variants:[], groupRefs:[]}
  links: [],         // {itemId|itemRef, groupId|groupRef} — привязки групп
  matched: [],
  warnings: [],
  skipped: [],
}
const map = { generatedAt: new Date().toISOString(), location: LOCATION_ID, items: {}, addons: {} }

// Категории: существующая или новая
const catRef = {} // siteCatId → {id?|uuid, name}
for (const [catId, meta] of Object.entries(CATS)) {
  const existing = kassaCatByName.get(norm(meta.he))
  if (existing) {
    catRef[catId] = { id: existing.id, name: existing.name }
  } else {
    const uuid = randomUUID()
    catRef[catId] = { uuid, name: meta.he }
    plan.newCategories.push({ uuid, he: meta.he, order: 100 + meta.order })
  }
}

// Группы модификаторов: найти/создать; вернуть ref и карту опций
const groupRefByAddon = {} // addonId → {id?|uuid}
function ensureGroup(nameHe, minSel, maxSel, options /* [{name, delta}] */, addonId) {
  const existing = kassaGroupByName.get(norm(nameHe))
  const optionMap = {} // labelHe → modifier uuid/id
  if (existing) {
    const missing = []
    for (const o of options) {
      const m = existing.modifiers.find((m) => norm(m.name) === norm(o.name))
      if (m) optionMap[o.name] = m.id
      else {
        const uuid = randomUUID()
        missing.push({ uuid, name: o.name, delta: o.delta })
        optionMap[o.name] = uuid
      }
    }
    if (missing.length) plan.addGroupMods.push({ groupId: existing.id, groupName: existing.name, mods: missing })
    map.addons[addonId ?? nameHe] = { kassaGroupId: existing.id, options: optionMap }
    return { id: existing.id }
  }
  const uuid = randomUUID()
  const mods = options.map((o) => {
    const mu = randomUUID()
    optionMap[o.name] = mu
    return { uuid: mu, name: o.name, delta: o.delta }
  })
  plan.newGroups.push({ uuid, name: nameHe, min: minSel, max: maxSel, mods })
  // повторный ensureGroup того же имени должен вернуть тот же uuid
  kassaGroupByName.set(norm(nameHe), { id: uuid, name: nameHe, modifiers: mods.map((m) => ({ id: m.uuid, name: m.name, delta: m.delta })) })
  map.addons[addonId ?? nameHe] = { kassaGroupId: uuid, options: optionMap }
  return { id: uuid }
}

// Простые добавки — в общую группу «תוספות»
const simpleAddons = addons.filter((a) => (a.type ?? 'simple') !== 'group')
if (simpleAddons.length) {
  const options = []
  const seen = new Set()
  for (const a of simpleAddons) {
    const name = a.labelHe || a.labelRu || a.label
    if (!name || seen.has(norm(name))) continue
    seen.add(norm(name))
    options.push({ name, delta: Math.round(Number(a.price ?? 0) * 100), addonId: a.id })
  }
  const ref = ensureGroup(EXTRAS_GROUP_HE, 0, 0, options, null)
  // карта: каждый простой addon → его модификатор в общей группе
  const extrasMap = map.addons[EXTRAS_GROUP_HE]
  for (const a of simpleAddons) {
    const name = a.labelHe || a.labelRu || a.label
    map.addons[a.id] = { kassaGroupId: ref.id, modifierId: extrasMap.options[name], simple: true }
  }
}

// Группы-добавки (кроме «גודל» — это размеры, не модификаторы)
for (const a of addons.filter((a) => a.type === 'group')) {
  const nameHe = a.labelHe || a.labelRu || a.label
  if (norm(nameHe) === norm('גודל')) continue // размер → item_variants
  const options = (a.options ?? []).map((o) => ({
    name: o.labelHe || o.labelRu || o.label,
    delta: Math.round(Number(o.price ?? 0) * 100),
  }))
  groupRefByAddon[a.id] = ensureGroup(nameHe, 0, 1, options, a.id)
}

// Позиции
for (const [catId, docs] of Object.entries(siteCats)) {
  for (const doc of docs) {
    const nameHe = doc.nameHe || doc.nameRu || doc.name
    if (!nameHe) { plan.skipped.push(`[${catId}] без названия (${doc.id})`); continue }

    const itemAddons = (doc.addons ?? []).map((id) => addonById.get(id)).filter(Boolean)
    const sizeAddon = itemAddons.find((a) => a.type === 'group' && norm(a.labelHe || '') === norm('גודל'))

    const existing = kassaItemByName.get(norm(ALIASES[nameHe] ?? nameHe)) ?? kassaItemByName.get(norm(doc.nameRu)) ?? kassaItemByName.get(norm(doc.name))
    if (existing) {
      plan.matched.push(`${nameHe}  →  ${existing.name}`)
      const variants = {}
      for (const v of existing.variants) variants[v.name] = v.id
      map.items[doc.id] = { kassaItemId: existing.id, name: existing.name, category: catId, variants, sizeAddonId: sizeAddon?.id ?? null }
      // Добавки сайта, которых нет у кассовой позиции → привязать группу
      // (иначе онлайн-заказ с этой добавкой отклонится: группа не у товара)
      for (const a of itemAddons) {
        if (a === sizeAddon) continue
        const gid = a.type === 'group' ? groupRefByAddon[a.id]?.id : map.addons[a.id]?.kassaGroupId
        if (gid && !existing.group_ids.includes(gid) && !plan.links.some((l) => l.itemId === existing.id && l.groupId === gid)) {
          plan.links.push({ itemId: existing.id, itemName: existing.name, groupId: gid })
        }
      }
      continue
    }

    const prices = parsePrices(doc.price)
    if (!prices.length) { plan.skipped.push(`[${catId}] ${nameHe} — нет цены («${doc.price ?? ''}»)`); continue }

    // Размеры: из группы «גודל» и/или двойной цены
    let variants = []
    const sizeOpts = (sizeAddon?.options ?? []).map((o) => ({
      name: o.labelHe || o.labelRu || o.label,
      delta: Math.round(Number(o.price ?? 0) * 100),
    }))
    if (prices.length >= 2 && sizeOpts.length === prices.length) {
      variants = sizeOpts.map((o, i) => ({ uuid: randomUUID(), name: o.name, price: prices[i], def: i === 0 }))
    } else if (prices.length >= 2) {
      plan.warnings.push(`${nameHe}: цена «${doc.price}» без подходящей группы размеров — создан по первой цене, размеры добавь руками`)
    } else if (sizeOpts.length >= 2) {
      variants = sizeOpts.map((o, i) => ({ uuid: randomUUID(), name: o.name, price: prices[0] + o.delta, def: i === 0 }))
    }

    if (doc.addonPrices && Object.keys(doc.addonPrices).length) {
      plan.warnings.push(`${nameHe}: у сайта персональные цены добавок (addonPrices) — в кассе будут стандартные`)
    }

    const groupRefs = []
    for (const a of itemAddons) {
      if (a === sizeAddon) continue
      if (a.type === 'group') { if (groupRefByAddon[a.id]) groupRefs.push(groupRefByAddon[a.id].id) }
      else if (map.addons[a.id]) groupRefs.push(map.addons[a.id].kassaGroupId)
    }
    const uniqueGroups = [...new Set(groupRefs)]

    const uuid = randomUUID()
    plan.newItems.push({
      uuid, catId, name: nameHe, price: prices[0],
      img: doc.img || null,
      available: doc.available !== false,
      sort: Number(doc.order ?? 0),
      variants, groupIds: uniqueGroups,
    })
    const vmap = {}
    for (const v of variants) vmap[v.name] = v.uuid
    map.items[doc.id] = { kassaItemId: uuid, name: nameHe, category: catId, variants: vmap, sizeAddonId: sizeAddon?.id ?? null }
  }
}

// ── отчёт ────────────────────────────────────────────────────

// Позиции кассы, к которым не нашлось пары на сайте: возможные дубли
// под другим именем (лечатся записью в ALIASES) или кассовые-only позиции.
const mappedKassaIds = new Set(Object.values(map.items).map((m) => m.kassaItemId))
const lonely = st.items.filter((i) => !mappedKassaIds.has(i.id))
if (lonely.length) {
  console.log(`\n═══ В кассе БЕЗ пары на сайте: ${lonely.length} (проверь на дубли с «новыми»!)`)
  for (const i of lonely) console.log(`  ? ${i.name} (${i.price / 100}₪)`)
}

console.log(`\n═══ Сматчено с кассой (не трогаем): ${plan.matched.length}`)
for (const m of plan.matched) console.log('  =', m)
console.log(`\n═══ Новые категории: ${plan.newCategories.length}`)
for (const c of plan.newCategories) console.log('  +', c.he)
console.log(`\n═══ Новые группы модификаторов: ${plan.newGroups.length}`)
for (const g of plan.newGroups) console.log(`  + ${g.name} (${g.mods.map((m) => `${m.name}+${m.delta / 100}`).join(', ')})`)
for (const g of plan.addGroupMods) console.log(`  ~ в «${g.groupName}» добавятся: ${g.mods.map((m) => m.name).join(', ')}`)
if (plan.links.length) {
  console.log(`\n═══ Привязки групп к существующим позициям кассы: ${plan.links.length}`)
  const byItem = {}
  for (const l of plan.links) (byItem[l.itemName] ??= []).push(l.groupId)
  for (const [n, gs] of Object.entries(byItem)) console.log(`  ~ ${n}: +${gs.length} гр.`)
}
console.log(`\n═══ Новые товары: ${plan.newItems.length}`)
for (const i of plan.newItems) {
  const v = i.variants.length ? ` [${i.variants.map((v) => `${v.name} ${v.price / 100}₪`).join(' / ')}]` : ` ${i.price / 100}₪`
  console.log(`  + [${i.catId}] ${i.name}${v}${i.groupIds.length ? ` +${i.groupIds.length} гр.мод.` : ''}${i.available ? '' : ' (стоп)'}`)
}
if (plan.warnings.length) {
  console.log(`\n⚠ Предупреждения: ${plan.warnings.length}`)
  for (const w of plan.warnings) console.log('  !', w)
}
if (plan.skipped.length) {
  console.log(`\n✗ Пропущено: ${plan.skipped.length}`)
  for (const s of plan.skipped) console.log('  -', s)
}

if (!APPLY) {
  console.log('\nDRY-RUN: в кассу ничего не записано. Запуск с --apply применит план и создаст kassa-map.json')
  process.exit(0)
}

// ── запись ───────────────────────────────────────────────────

const stmts = ['BEGIN;']
for (const c of plan.newCategories) {
  stmts.push(`INSERT INTO menu_categories (id, org_id, location_id, name, sort_order) VALUES ('${c.uuid}', '${ORG}', '${LOCATION_ID}', '${esc(c.he)}', ${c.order});`)
}
for (const g of plan.newGroups) {
  stmts.push(`INSERT INTO modifier_groups (id, org_id, name, min_select, max_select, sort_order) VALUES ('${g.uuid}', '${ORG}', '${esc(g.name)}', ${g.min}, ${g.max}, 0);`)
  g.mods.forEach((m, i) => {
    stmts.push(`INSERT INTO modifiers (id, org_id, group_id, name, price_delta, sort_order) VALUES ('${m.uuid}', '${ORG}', '${g.uuid}', '${esc(m.name)}', ${m.delta}, ${i * 10});`)
  })
}
for (const g of plan.addGroupMods) {
  g.mods.forEach((m, i) => {
    stmts.push(`INSERT INTO modifiers (id, org_id, group_id, name, price_delta, sort_order) VALUES ('${m.uuid}', '${ORG}', '${g.groupId}', '${esc(m.name)}', ${m.delta}, ${100 + i * 10});`)
  })
}
for (const i of plan.newItems) {
  const cat = catRef[i.catId]
  const catIdSql = cat.id ?? cat.uuid
  stmts.push(`INSERT INTO menu_items (id, org_id, category_id, name, price, image_url, is_available, ask_modifiers, sort_order) VALUES ('${i.uuid}', '${ORG}', '${catIdSql}', '${esc(i.name)}', ${i.price}, ${i.img ? `'${esc(i.img)}'` : 'NULL'}, ${i.available}, ${i.groupIds.length > 0 || i.variants.length > 0}, ${i.sort});`)
  i.variants.forEach((v, vi) => {
    stmts.push(`INSERT INTO item_variants (id, org_id, item_id, name, price, is_default, sort_order) VALUES ('${v.uuid}', '${ORG}', '${i.uuid}', '${esc(v.name)}', ${v.price}, ${v.def}, ${vi * 10});`)
  })
  i.groupIds.forEach((gid, gi) => {
    stmts.push(`INSERT INTO menu_item_modifier_groups (item_id, group_id, org_id, sort_order) VALUES ('${i.uuid}', '${gid}', '${ORG}', ${gi * 10});`)
  })
}
for (const l of plan.links) {
  stmts.push(`INSERT INTO menu_item_modifier_groups (item_id, group_id, org_id, sort_order) VALUES ('${l.itemId}', '${l.groupId}', '${ORG}', 100) ON CONFLICT DO NOTHING;`)
}
stmts.push('COMMIT;')

console.log(`\nПрименяю: ${stmts.length - 2} INSERT...`)
await sql(stmts.join('\n'))
console.log('✓ Записано в каталог кассы')

writeFileSync(MAP_OUT, JSON.stringify(map, null, 2))
console.log(`✓ Карта связки: ${MAP_OUT} (позиций: ${Object.keys(map.items).length})`)
