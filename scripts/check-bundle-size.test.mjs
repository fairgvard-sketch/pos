// Тесты бюджета стартового JS. Запуск:
//   node --test scripts/check-bundle-size.test.mjs
//
// Отдельный runner, а не vitest: скрипт сборки не относится к src, браузер и
// jsdom ему не нужны, и прогон не должен зависеть от наличия реального dist/.
// Каждый тест собирает свой минимальный «dist» во временном каталоге.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BundleCheckError,
  DEFAULT_BUDGETS,
  analyzeStartupBundles,
  collectBranch,
  main,
  parseStartupHtml,
  staticImportsOf,
} from './check-bundle-size.mjs'

const SCRIPT = fileURLToPath(new URL('./check-bundle-size.mjs', import.meta.url))

/** index.html в том же виде, в каком его печатает vite + plugin-legacy. */
function html({
  modern = ['/assets/index.js'],
  preloads = [],
  polyfill = '/assets/polyfills-legacy.js',
  legacyEntry = '/assets/index-legacy.js',
} = {}) {
  return `<!doctype html><html><head>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" crossorigin href="/assets/index.css">
${modern.map((src) => `<script type="module" crossorigin src="${src}"></script>`).join('\n')}
${preloads.map((href) => `<link rel="modulepreload" crossorigin href="${href}">`).join('\n')}
<script type="module">window.__vite_is_modern_browser=true</script>
</head><body>
<script nomodule>!function(){}();</script>
${polyfill ? `<script nomodule crossorigin id="vite-legacy-polyfill" src="${polyfill}"></script>` : ''}
${legacyEntry ? `<script nomodule crossorigin id="vite-legacy-entry" data-src="${legacyEntry}">System.import(document.getElementById('vite-legacy-entry').getAttribute('data-src'))</script>` : ''}
</body></html>`
}

/** Временный каталог сборки: { 'index.html': …, 'assets/x.js': … }. */
function makeDist(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'kassa-bundle-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

function gzipOf(text) {
  return gzipSync(Buffer.from(text)).byteLength
}

function branch(report, kind) {
  return report.branches.find((item) => item.kind === kind)
}

function paths(report, kind) {
  return branch(report, kind).files.map((file) => file.path).sort()
}

/** Минимальная корректная legacy-ветка, когда проверяется что-то другое. */
const LEGACY_OK = {
  'assets/polyfills-legacy.js': '!function(){"use strict"}();',
  'assets/index-legacy.js': 'System.register([],function(e,n){return{setters:[],execute:function(){}}});',
}

test('modern-ветка: entry, modulepreload и транзитивные статические импорты', (t) => {
  const entry = 'import"./shared.js";import{jsx as a}from"./jsx.js";const d=()=>import("./LazyPage.js");export{a,d};'
  const dist = makeDist(t, {
    'index.html': html({ preloads: ['/assets/jsx.js', '/assets/shared.js'] }),
    'assets/index.js': entry,
    'assets/jsx.js': 'export const jsx=()=>{};',
    'assets/shared.js': 'export{}from"./deep.js";',
    'assets/deep.js': 'export const deep=1;',
    'assets/LazyPage.js': `export const page="${'x'.repeat(4096)}";`,
    ...LEGACY_OK,
  })

  const report = analyzeStartupBundles({ distDir: dist })

  assert.deepEqual(paths(report, 'modern'), [
    'assets/deep.js',
    'assets/index.js',
    'assets/jsx.js',
    'assets/shared.js',
  ])
  assert.equal(
    branch(report, 'modern').total,
    gzipOf(entry) + gzipOf('export const jsx=()=>{};') + gzipOf('export{}from"./deep.js";') + gzipOf('export const deep=1;'),
  )
  assert.equal(report.ok, true)
})

test('ленивые страницы не считаются первоначальной загрузкой', (t) => {
  const lazy = `export const page="${'y'.repeat(200000)}";`
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'const p=()=>import("./LazyPage.js");const q=()=>import(/* webpackIgnore */"./Other.js");export{p,q};',
    'assets/LazyPage.js': lazy,
    'assets/Other.js': lazy,
    ...LEGACY_OK,
  })

  const report = analyzeStartupBundles({ distDir: dist })

  assert.deepEqual(paths(report, 'modern'), ['assets/index.js'])
  assert.ok(branch(report, 'modern').total < 1024, 'ленивый чанк не должен попадать в бюджет')
})

test('legacy-ветка: polyfills, entry и зависимости System.register', (t) => {
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'export const a=1;',
    'assets/polyfills-legacy.js': `!function(){var systemJs="${'p'.repeat(2048)}"}();`,
    'assets/index-legacy.js':
      'System.register(["./jsx-legacy.js"],function(e,n){return{setters:[function(){}],execute:function(){n.import("./LazyPage-legacy.js")}}});',
    'assets/jsx-legacy.js': 'System.register(["./shared-legacy.js"],function(){return{setters:[function(){}],execute:function(){}}});',
    'assets/shared-legacy.js': 'System.register([],function(){return{setters:[],execute:function(){}}});',
    'assets/LazyPage-legacy.js': `System.register([],function(){var big="${'z'.repeat(100000)}";return{setters:[],execute:function(){}}});`,
  })

  const report = analyzeStartupBundles({ distDir: dist })

  assert.deepEqual(paths(report, 'legacy'), [
    'assets/index-legacy.js',
    'assets/jsx-legacy.js',
    'assets/polyfills-legacy.js',
    'assets/shared-legacy.js',
  ])
})

test('общая зависимость и цикл считаются один раз и не зацикливают обход', (t) => {
  const dist = makeDist(t, {
    'assets/a.js': 'import"./b.js";import"./c.js";export const a=1;',
    'assets/b.js': 'import"./c.js";export const b=1;',
    'assets/c.js': 'import"./a.js";export const c=1;',
  })

  const files = collectBranch(dist, [{ url: '/assets/a.js', reason: 'entry' }], 'modern')

  assert.deepEqual(files.map((file) => file.path).sort(), ['assets/a.js', 'assets/b.js', 'assets/c.js'])
  assert.equal(
    files.reduce((sum, file) => sum + file.gzip, 0),
    gzipOf('import"./b.js";import"./c.js";export const a=1;') +
      gzipOf('import"./c.js";export const b=1;') +
      gzipOf('import"./a.js";export const c=1;'),
  )
  const shared = files.find((file) => file.path === 'assets/c.js')
  assert.deepEqual(shared.reasons, ['статический импорт'])
})

test('файл, попавший в ветку дважды, сохраняет обе причины включения', (t) => {
  const dist = makeDist(t, {
    'index.html': html({ preloads: ['/assets/jsx.js'] }),
    'assets/index.js': 'import"./jsx.js";export const a=1;',
    'assets/jsx.js': 'export const jsx=1;',
    ...LEGACY_OK,
  })

  const report = analyzeStartupBundles({ distDir: dist })
  const jsx = branch(report, 'modern').files.find((file) => file.path === 'assets/jsx.js')

  assert.deepEqual(jsx.reasons, ['modulepreload', 'статический импорт'])
  assert.equal(branch(report, 'modern').files.length, 2)
})

test('отсутствующий ассет — ошибка, а не молчаливо меньший бюджет', (t) => {
  const dist = makeDist(t, {
    'index.html': html({ preloads: ['/assets/jsx.js'] }),
    'assets/index.js': 'export const a=1;',
    ...LEGACY_OK,
  })

  assert.throws(() => analyzeStartupBundles({ distDir: dist }), (error) => {
    assert.ok(error instanceof BundleCheckError)
    assert.match(error.message, /assets\/jsx\.js отсутствует/)
    return true
  })
  assert.equal(main(['--dist', dist]), 1)
})

test('отсутствующая цель статического импорта — ошибка', (t) => {
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import"./missing.js";export const a=1;',
    ...LEGACY_OK,
  })

  assert.throws(
    () => analyzeStartupBundles({ distDir: dist }),
    /assets\/missing\.js отсутствует/,
  )
})

test('превышение бюджета — OVER и код выхода 1', (t) => {
  const big = randomBytes(320 * 1024).toString('base64')
  const dist = makeDist(t, {
    'index.html': html({ preloads: ['/assets/heavy.js'] }),
    'assets/index.js': 'export const a=1;',
    'assets/heavy.js': `export const heavy="${big}";`,
    ...LEGACY_OK,
  })

  const report = analyzeStartupBundles({ distDir: dist })
  assert.equal(branch(report, 'modern').ok, false)
  assert.ok(branch(report, 'modern').total > DEFAULT_BUDGETS.modern)
  assert.equal(report.ok, false)

  const cli = spawnSync(process.execPath, [SCRIPT, '--dist', dist], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.match(cli.stdout, /OVER modern startup JS/)
})

test('бюджет сравнивается с суммой ветки, а не с размером entry', (t) => {
  const half = randomBytes(96 * 1024).toString('base64')
  const dist = makeDist(t, {
    'index.html': html({ preloads: ['/assets/part.js'] }),
    'assets/index.js': `export const a="${half}";`,
    'assets/part.js': `export const b="${half}";`,
    ...LEGACY_OK,
  })

  const budgets = { modern: 120 * 1024, legacy: DEFAULT_BUDGETS.legacy }
  const report = analyzeStartupBundles({ distDir: dist, budgets })

  const files = branch(report, 'modern').files
  assert.ok(files.every((file) => file.gzip < budgets.modern), 'каждый файл по отдельности в бюджет влезает')
  assert.equal(branch(report, 'modern').ok, false, 'сумма ветки бюджет превышает')
})

test('нет index.html — код выхода 1 и подсказка про build', (t) => {
  const dist = makeDist(t, { 'assets/index.js': 'export const a=1;' })

  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /npm run build/)

  const cli = spawnSync(process.execPath, [SCRIPT, '--dist', dist], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /FAIL check-bundle-size/)
})

test('нет legacy-ветки — артефакт считается некорректным', (t) => {
  const dist = makeDist(t, {
    'index.html': html({ polyfill: '', legacyEntry: '' }),
    'assets/index.js': 'export const a=1;',
  })

  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /нет legacy-ветки/)
  assert.equal(main(['--dist', dist]), 1)
})

test('нет модульного entry — артефакт считается некорректным', (t) => {
  const dist = makeDist(t, { 'index.html': html({ modern: [] }), ...LEGACY_OK })

  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /нет модульного entry/)
})

test('стартовый ресурс с внешнего адреса — ошибка', (t) => {
  const dist = makeDist(t, {
    'index.html': html({ modern: ['https://cdn.example.com/index.js'] }),
    ...LEGACY_OK,
  })

  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /вне сборки/)
})

test('ассет за пределами dist не считается', (t) => {
  const dist = makeDist(t, {
    'index.html': html({ modern: ['/assets/index.js'] }),
    'assets/index.js': 'import"../../secret.js";export const a=1;',
    ...LEGACY_OK,
  })

  // Браузер обрезал бы `../../` до корня сайта и молча взял другой файл;
  // для бюджета такая ссылка — сломанный артефакт.
  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /выходит за пределы dist/)
})

test('успешный прогон печатает состав обеих веток и выходит с 0', (t) => {
  const dist = makeDist(t, {
    'index.html': html({ preloads: ['/assets/jsx.js'] }),
    'assets/index.js': 'import"./jsx.js";export const a=1;',
    'assets/jsx.js': 'export const jsx=1;',
    ...LEGACY_OK,
  })

  const cli = spawnSync(process.execPath, [SCRIPT, '--dist', dist], { encoding: 'utf8' })

  assert.equal(cli.status, 0)
  assert.match(cli.stdout, /OK modern startup JS: .* KiB gzip \/ 240\.0 KiB gzip/)
  assert.match(cli.stdout, /OK legacy startup JS: .* KiB gzip \/ 310\.0 KiB gzip/)
  for (const file of ['assets/index.js', 'assets/jsx.js', 'assets/polyfills-legacy.js', 'assets/index-legacy.js']) {
    assert.ok(cli.stdout.includes(file), `в отчёте нет ${file}`)
  }
})

test('неизвестный аргумент CLI — код выхода 1', () => {
  const cli = spawnSync(process.execPath, [SCRIPT, '--budget', '999'], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /неизвестный аргумент/)
})

test('пороги остаются прежними', () => {
  assert.deepEqual(DEFAULT_BUDGETS, { modern: 240 * 1024, legacy: 310 * 1024 })
})

test('parseStartupHtml различает ветки и игнорирует посторонние теги', () => {
  const parsed = parseStartupHtml(html({ preloads: ['/assets/jsx.js'] }))

  assert.deepEqual(parsed.modern, [
    { url: '/assets/index.js', reason: 'entry' },
    { url: '/assets/jsx.js', reason: 'modulepreload' },
  ])
  assert.deepEqual(parsed.legacy, [
    { url: '/assets/polyfills-legacy.js', reason: 'legacy polyfills' },
    { url: '/assets/index-legacy.js', reason: 'legacy entry' },
  ])
})

test('staticImportsOf берёт только статические импорты', () => {
  const modern = staticImportsOf(
    'const __vite__mapDeps=["assets/App.js","assets/i18n.js"];import"./a.js";import{x}from"./b.js";' +
      'export*from"./c.js";import*as n from"./d.js";const p=import("./lazy.js");import.meta.url;',
    'modern',
  )
  assert.deepEqual(modern, ['./a.js', './b.js', './c.js', './d.js'])

  const legacy = staticImportsOf(
    'System.register(["./a-legacy.js","./b-legacy.js"],function(){});' +
      'systemJSPrototype.register(function(e,n){});e.System.register(x,y);',
    'legacy',
  )
  assert.deepEqual(legacy, ['./a-legacy.js', './b-legacy.js'])
})

// --- корректность разбора (F8.1-R1) -----------------------------------------
// Ложный OK занижает бюджет, ложный FAIL блокирует релиз: обе ошибки
// проверяются на настоящем CLI, а не только на экспортируемых функциях.

test('modulepreload не заменяет модульный entry', (t) => {
  const dist = makeDist(t, {
    'index.html': html({ modern: [], preloads: ['/assets/jsx.js'] }),
    'assets/jsx.js': 'export const jsx=1;',
    ...LEGACY_OK,
  })

  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /нет модульного entry/)
  const cli = spawnSync(process.execPath, [SCRIPT, '--dist', dist], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
})

test('root-relative статический импорт считается, а его пропажа — отказ', (t) => {
  const missing = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import"/assets/missing.js";export const a=1;',
    ...LEGACY_OK,
  })
  assert.throws(() => analyzeStartupBundles({ distDir: missing }), /assets\/missing\.js отсутствует/)
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--dist', missing], { encoding: 'utf8' }).status, 1)

  const present = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import"/assets/shared.js";export const a=1;',
    'assets/shared.js': 'export const shared=1;',
    ...LEGACY_OK,
  })
  assert.deepEqual(paths(analyzeStartupBundles({ distDir: present }), 'modern'), [
    'assets/index.js',
    'assets/shared.js',
  ])
})

test('внешний статический импорт — отказ, а не молча меньший бюджет', (t) => {
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import"https://cdn.example.test/shared.js";export const a=1;',
    ...LEGACY_OK,
  })

  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /внешний статический импорт/)
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--dist', dist], { encoding: 'utf8' }).status, 1)
})

test('bare-спецификатор не резолвится в браузере — отказ', (t) => {
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import"react";export const a=1;',
    ...LEGACY_OK,
  })

  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /неподдержанный спецификатор/)
})

test('импорт с #fragment: считается тот же файл, его пропажа — отказ', (t) => {
  const missing = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import"./missing.js#v1";export const a=1;',
    ...LEGACY_OK,
  })
  assert.throws(() => analyzeStartupBundles({ distDir: missing }), /assets\/missing\.js отсутствует/)
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--dist', missing], { encoding: 'utf8' }).status, 1)

  const present = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import"./shared.js#v1";export const a=1;',
    'assets/shared.js': 'export const shared=1;',
    ...LEGACY_OK,
  })
  assert.deepEqual(paths(analyzeStartupBundles({ distDir: present }), 'modern'), [
    'assets/index.js',
    'assets/shared.js',
  ])
})

test('?v= у одного файла — один файл в бюджете, а не два запроса', (t) => {
  const shared = 'export const shared=1;'
  const dist = makeDist(t, {
    'index.html': html({ preloads: ['/assets/shared.js'] }),
    'assets/index.js': 'import"./shared.js?v=1";import"./shared.js?v=2";export const a=1;',
    'assets/shared.js': shared,
    ...LEGACY_OK,
  })

  const report = analyzeStartupBundles({ distDir: dist })
  assert.deepEqual(paths(report, 'modern'), ['assets/index.js', 'assets/shared.js'])
  assert.equal(
    branch(report, 'modern').total,
    gzipOf('import"./shared.js?v=1";import"./shared.js?v=2";export const a=1;') + gzipOf(shared),
    'файл с двумя адресами занимает место в бюджете один раз',
  )

  const cli = spawnSync(process.execPath, [SCRIPT, '--dist', dist], { encoding: 'utf8' })
  assert.equal(cli.status, 0)
  assert.match(cli.stdout, /assets\/shared\.js/)
  assert.ok(!cli.stdout.includes('?v='), 'в отчёте — файл сборки, а не URL с query')
})

test('текст, похожий на импорт, внутри строки JS — не зависимость', (t) => {
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': `const text='import "./ghost.js"';const also="export{x}from './ghost.js'";export{text,also};`,
    ...LEGACY_OK,
  })

  const report = analyzeStartupBundles({ distDir: dist })
  assert.deepEqual(paths(report, 'modern'), ['assets/index.js'])
  assert.equal(main(['--dist', dist]), 0)
})

test('комментарии JS не создают зависимостей', (t) => {
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': '/* import "./ghost.js" */\n// import "./ghost2.js"\nexport const a=1;',
    ...LEGACY_OK,
  })

  assert.deepEqual(paths(analyzeStartupBundles({ distDir: dist }), 'modern'), ['assets/index.js'])
})

test('<script> внутри HTML-комментария не попадает в стартовый граф', (t) => {
  const dist = makeDist(t, {
    'index.html': html().replace(
      '</head>',
      '<!-- <script type="module" src="/assets/ghost.js"></script>\n'
        + '<link rel="modulepreload" href="/assets/ghost.js"> --></head>',
    ),
    'assets/index.js': 'export const a=1;',
    ...LEGACY_OK,
  })

  assert.deepEqual(paths(analyzeStartupBundles({ distDir: dist }), 'modern'), ['assets/index.js'])
})

test('строка с System.register в legacy-чанке — не зависимость', (t) => {
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'export const a=1;',
    'assets/polyfills-legacy.js': '!function(){"use strict"}();',
    'assets/index-legacy.js':
      `var t='System.register(["./ghost-legacy.js"],function(){})';`
      + 'System.register([],function(e,n){return{setters:[],execute:function(){}}});',
  })

  const report = analyzeStartupBundles({ distDir: dist })
  assert.deepEqual(paths(report, 'legacy'), ['assets/index-legacy.js', 'assets/polyfills-legacy.js'])
  assert.equal(main(['--dist', dist]), 0)
})

test('именованная форма System.register("name",[…]) тоже даёт зависимости', () => {
  const deps = staticImportsOf(
    'System.register("chunk",["./a-legacy.js"],function(){});System.register(["./b-legacy.js"],function(){});',
    'legacy',
  )
  assert.deepEqual(deps, ['./a-legacy.js', './b-legacy.js'])
})

test('собранный JS разбирается, а не исполняется', (t) => {
  // Побочные эффекты артефакта не должны влиять на проверку: скрипт читает
  // синтаксис, не запускает eval/vm и не импортирует чанки.
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'process.exit(3);throw new Error("не должно выполняться");export const a=1;',
    ...LEGACY_OK,
  })

  const cli = spawnSync(process.execPath, [SCRIPT, '--dist', dist], { encoding: 'utf8' })
  assert.equal(cli.status, 0)
  assert.match(cli.stdout, /OK modern startup JS/)
})

test('inline-модуль data: не файл сборки и не отказ', (t) => {
  // Так Vite проверяет поддержку import.meta.resolve в modern-ветке: текст
  // модуля лежит внутри entry и уже посчитан вместе с ним.
  const entry =
    `import'data:text/javascript,"assets/index.js";if(!import.meta.resolve)throw Error("no")';export const a=1;`
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': entry,
    ...LEGACY_OK,
  })

  const report = analyzeStartupBundles({ distDir: dist })
  assert.deepEqual(paths(report, 'modern'), ['assets/index.js'])
  assert.equal(branch(report, 'modern').total, gzipOf(entry))
  assert.equal(main(['--dist', dist]), 0)
})

test('data:-модуль со статическими зависимостями даёт отказ', (t) => {
  const data = 'data:text/javascript,' + encodeURIComponent('import "https://cdn.example.test/shared.js";')
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': `import ${JSON.stringify(data)};export const a=1;`,
    ...LEGACY_OK,
  })
  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /статические зависимости data:/)
})

test('data: в HTML не заменяет посчитанный entry', (t) => {
  const dist = makeDist(t, {
    'index.html': html().replace('/assets/index.js', 'data:text/javascript,export default 1'),
    ...LEGACY_OK,
  })
  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /стартовый ресурс вне сборки/)
})

test('неподдержанный base64 data:-модуль не пропускается', (t) => {
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import "data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgMQ==";',
    ...LEGACY_OK,
  })
  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /неподдержанный формат data:/)
})

test('статические импорты inline HTML-модуля не пропускаются', (t) => {
  const dist = makeDist(t, {
    'index.html': html() + '<script type="module">import "/assets/missing.js";</script>',
    'assets/index.js': 'export const a=1;',
    ...LEGACY_OK,
  })
  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /статические импорты inline-модуля/)
})

test('реальный detector Vite в inline HTML не добавляет файлов', (t) => {
  const dist = makeDist(t, {
    'index.html': html() + '<script type="module">import\'data:text/javascript,if(!import.meta.resolve)throw Error("import.meta.resolve not supported")\';import.meta.url;import("_").catch(()=>1);(async function*(){})().next();window.__vite_is_modern_browser=true</script>',
    'assets/index.js': 'export const a=1;',
    ...LEGACY_OK,
  })
  assert.deepEqual(paths(analyzeStartupBundles({ distDir: dist }), 'modern'), ['assets/index.js'])
})

test('data:-импорт в inline HTML также проверяется на зависимости', (t) => {
  const data = 'data:text/javascript,' + encodeURIComponent('import "https://cdn.example.test/shared.js";')
  const dist = makeDist(t, {
    'index.html': html() + `<script type="module">import ${JSON.stringify(data)};</script>`,
    'assets/index.js': 'export const a=1;',
    ...LEGACY_OK,
  })
  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /статические зависимости data:/)
})

test('ошибка разбора JS не выдаётся за полный граф', (t) => {
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import {',
    ...LEGACY_OK,
  })
  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /ошибка разбора JS/)
})

test('URL нормализуется: разные записи одного файла — одна запись бюджета', (t) => {
  const shared = 'export const shared=1;'
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import"./sub/../shared.js";import"/assets/%73hared.js";export const a=1;',
    'assets/shared.js': shared,
    ...LEGACY_OK,
  })

  const report = analyzeStartupBundles({ distDir: dist })
  assert.deepEqual(paths(report, 'modern'), ['assets/index.js', 'assets/shared.js'])
  assert.equal(
    branch(report, 'modern').files.find((file) => file.path === 'assets/shared.js').gzip,
    gzipOf(shared),
  )
})

test('процентная запись `..` тоже считается выходом за dist', (t) => {
  const dist = makeDist(t, {
    'index.html': html(),
    'assets/index.js': 'import"./%2e%2e/%2e%2e/secret.js";export const a=1;',
    ...LEGACY_OK,
  })

  assert.throws(() => analyzeStartupBundles({ distDir: dist }), /выходит за пределы dist/)
})

test('inline-скрипт в index.html не исполняется при разборе', (t) => {
  const dist = makeDist(t, {
    'index.html': html().replace(
      '</body>',
      '<script>document.head.insertAdjacentHTML("beforeend",'
        + '\'<script type="module" src="/assets/ghost.js"><\\/script>\')</script></body>',
    ),
    'assets/index.js': 'export const a=1;',
    ...LEGACY_OK,
  })

  assert.deepEqual(paths(analyzeStartupBundles({ distDir: dist }), 'modern'), ['assets/index.js'])
})
