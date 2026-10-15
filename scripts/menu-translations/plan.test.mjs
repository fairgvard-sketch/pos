import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSql, normName, planTranslations } from './plan.mjs'

const dict = {
  categories: { 'משקאות חמים': { en: 'Hot Drinks', ru: 'Горячие напитки' } },
  items: {
    "קפוצ'ינו": {
      source: 'הפוך בישראלי.',
      en: { name: 'Cappuccino', description: 'The Israeli “hafuch”.' },
      ru: { name: 'Капучино', description: 'Израильский «афух».' },
    },
    'לאטה': {
      source: 'כוס גדולה עם חלב.',
      en: { name: 'Latte', description: 'A large cup of milk.' },
      ru: { name: 'Латте', description: 'Большая чашка молока.' },
    },
  },
  variants: { 'קטן': { en: 'Small', ru: 'Маленький' } },
  groups: {},
  modifiers: { 'שיבולת שועל': { en: 'Oat milk', ru: 'Овсяное' } },
}

describe('normName', () => {
  it('не различает вид апострофа, пробелы и тире', () => {
    assert.equal(normName("קפוצ׳ינו"), normName("קפוצ'ינו"))
    assert.equal(normName('  מיץ  מיקס - צהוב '), normName('מיץ מיקס — צהוב'))
  })
})

describe('planTranslations', () => {
  const catalog = {
    categories: [{ id: 'c1', name: 'משקאות חמים', translations: {} }],
    items: [
      { id: 'i1', name: 'קפוצ׳ינו', description: 'הפוך בישראלי.', translations: {} },
      { id: 'i2', name: 'לאטה', description: 'לאטה עם הרבה חלב.', translations: { he: { name: 'לאטה' } } },
      { id: 'i3', name: 'מנה חדשה', description: null, translations: {} },
    ],
    variants: [{ id: 'v1', name: 'קטן', translations: { en: { name: 'Tiny' } } }],
    groups: [],
    modifiers: [{ id: 'm1', name: 'שיבולת שועל', translations: { en: { name: 'Oat milk' }, ru: { name: 'Овсяное' } } }],
  }

  it('переводит название и описание, пока ивритский оригинал прежний', () => {
    const plan = planTranslations(catalog, dict)
    const cappuccino = plan.updates.find((u) => u.id === 'i1')
    assert.deepEqual(cappuccino.after, {
      en: { name: 'Cappuccino', description: 'The Israeli “hafuch”.' },
      ru: { name: 'Капучино', description: 'Израильский «афух».' },
    })
    assert.equal(cappuccino.table, 'menu_items')
  })

  it('изменённое описание: только название, описание — в отчёт; he сохраняется', () => {
    const plan = planTranslations(catalog, dict)
    const latte = plan.updates.find((u) => u.id === 'i2')
    assert.deepEqual(latte.after, { he: { name: 'לאטה' }, en: { name: 'Latte' }, ru: { name: 'Латте' } })
    assert.deepEqual(plan.staleDescriptions.map((s) => s.id), ['i2'])
  })

  it('ручной перевод владельца не перезаписывается без overwrite', () => {
    const kept = planTranslations(catalog, dict).updates.find((u) => u.id === 'v1')
    assert.deepEqual(kept.after, { en: { name: 'Tiny' }, ru: { name: 'Маленький' } })
    const replaced = planTranslations(catalog, dict, { overwrite: true }).updates.find((u) => u.id === 'v1')
    assert.deepEqual(replaced.after, { en: { name: 'Small' }, ru: { name: 'Маленький' } })
  })

  it('уже переведённое не трогает, а неизвестное называет', () => {
    const plan = planTranslations(catalog, dict)
    assert.equal(plan.updates.some((u) => u.id === 'm1'), false)
    assert.equal(plan.unchanged, 1)
    assert.deepEqual(plan.unmatched, [{ kind: 'items', id: 'i3', name: 'מנה חדשה' }])
  })
})

describe('buildSql', () => {
  it('одна транзакция, запись только в своей организации, кавычки экранированы', () => {
    const sql = buildSql({
      updates: [{ table: 'menu_items', id: 'i1', after: { en: { name: "Don't" } } }],
    }, { orgId: 'org-1', locationId: 'loc-1', enableLanguages: ['en', 'ru'] })
    assert.match(sql, /^BEGIN;/)
    assert.match(sql, /COMMIT;$/)
    assert.match(sql, /UPDATE menu_items SET translations = '\{"en":\{"name":"Don''t"\}\}'::jsonb WHERE id = 'i1' AND org_id = 'org-1';/)
    assert.match(sql, /'languages', '\["en","ru"\]'::jsonb/)
    assert.match(sql, /WHERE id = 'loc-1' AND org_id = 'org-1';/)
  })
})

describe('словарь Bulochka', () => {
  const bulochka = JSON.parse(readFileSync(new URL('./bulochka.json', import.meta.url), 'utf8'))

  it('у каждого блюда есть английское и русское название в пределах лимитов базы', () => {
    for (const [name, entry] of Object.entries(bulochka.items)) {
      for (const lang of ['en', 'ru']) {
        assert.ok(entry[lang]?.name?.trim(), `${name}: нет ${lang}`)
        assert.ok(entry[lang].name.length <= 120, `${name}: ${lang} длиннее 120`)
        assert.ok((entry[lang].description ?? '').length <= 1000, `${name}: описание длиннее 1000`)
      }
      assert.equal(typeof entry.source, 'string', `${name}: нет исходного описания`)
    }
  })

  it('в английском нет кириллицы и иврита, в русском — иврита', () => {
    const texts = (lang) => [
      ...Object.values(bulochka.items).flatMap((e) => [e[lang].name, e[lang].description ?? '']),
      ...['categories', 'variants', 'groups', 'modifiers'].flatMap((k) => Object.values(bulochka[k]).map((e) => e[lang])),
    ]
    assert.deepEqual(texts('en').filter((t) => /[А-Яа-яЁё֐-׿]/.test(t)), [])
    assert.deepEqual(texts('ru').filter((t) => /[֐-׿]/.test(t)), [])
  })
})
