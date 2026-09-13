#!/usr/bin/env node
/**
 * Бюджет стартового JS: считает СТАТИЧЕСКИЙ стартовый граф сборки отдельно для
 * modern- и legacy-ветки.
 *
 * Что именно измеряется: уникальные файлы, которые браузер обязан скачать по
 * статическим ссылкам сборки, — модульный entry, `modulepreload`, legacy
 * polyfills и legacy entry плюс их транзитивные статические импорты. Это НЕ
 * «весь JS до первого полезного экрана»: динамический `import()` /
 * `System.import()` в бюджет не входит, хотя приложение может вызвать его сразу
 * после старта. Исключение динамики — граница этой метрики, а не доказательство
 * отложенной загрузки; отдельные ленивые страницы измеряются иначе.
 *
 * Считаются файлы, а не HTTP-запросы: один и тот же файл, упомянутый дважды
 * (общая зависимость, цикл, разные `?v=` у одного адреса), занимает место в
 * бюджете один раз. Сумма — gzip каждого файла по отдельности.
 *
 * Разбор без исполнения артефакта: HTML читается jsdom (скрипты не выполняются,
 * внешние ресурсы не загружаются), JS разбирается парсером TypeScript. Поэтому
 * `import` внутри строки, закомментированный `<script>` и текст, похожий на
 * `System.register([...])`, не становятся ложными зависимостями. `eval`, `vm` и
 * импорт собранного кода не используются.
 *
 * Неподдержанная или недостижимая ссылка — это отказ, а не молча уменьшенный
 * бюджет: внешний адрес (`https://…`, `//cdn…`), bare-спецификатор, выход за
 * пределы `dist` и отсутствующий файл дают exit 1. Единственная ссылка без
 * отдельного файла — импортированный inline-модуль `data:text/javascript,`
 * без статических зависимостей (Vite проверяет им `import.meta.resolve`):
 * его байты уже посчитаны внутри импортирующего файла. Иные inline-графы
 * не поддерживаются и дают отказ, а не исключение из бюджета.
 *
 * Использование:
 *   node scripts/check-bundle-size.mjs [--dist <путь>]
 *
 * Ненулевой код выхода → бюджет превышен либо артефакт сборки некорректен
 * (нет index.html, нет одной из веток, нет модульного entry, ссылка на
 * отсутствующий/внешний/непосчитываемый ресурс).
 */
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Пороги не поднимаются под факт сборки: превышение — повод чинить бандл.
export const DEFAULT_BUDGETS = {
  modern: 240 * 1024,
  legacy: 310 * 1024,
}

const BRANCH_LABELS = {
  modern: 'modern startup JS',
  legacy: 'legacy startup JS',
}

/** Ошибка бюджета/артефакта: CLI печатает её как FAIL и выходит с кодом 1. */
export class BundleCheckError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BundleCheckError'
  }
}

function fail(message) {
  throw new BundleCheckError(message)
}

// --- адреса ------------------------------------------------------------------

// Ссылки нормализуются как URL (а не склейкой строк): так `?v=1`, `#hash`,
// `%2e%2e` и лишние сегменты разбираются по правилам браузера. Префикс-метка
// нужна, чтобы отличить нормализацию внутри dist от выхода за его пределы:
// браузер обрезал бы `../../secret.js` до корня сайта, а для бюджета такая
// ссылка — сломанный артефакт, а не «файл в корне».
const VIRTUAL_ORIGIN = 'http://dist.invalid'
const ROOT_MARK = '/__dist__/'
const ROOT_URL = `${VIRTUAL_ORIGIN}${ROOT_MARK}`

function isExternal(url) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('//')
}

// Поддерживается только dependency-free форма, которую выпускает Vite.
// Без проверки содержимого `data:` мог бы скрыть внешний статический импорт.
const INLINE_MODULE = /^data:/i

function validateInlineModule(specifier, context) {
  const url = new URL(specifier)
  url.hash = ''
  const prefix = /^data:text\/javascript,/i.exec(url.href)
  if (!prefix) fail(`${context}: неподдержанный формат data:-модуля`)
  let code
  try {
    code = decodeURIComponent(url.href.slice(prefix[0].length))
  } catch {
    fail(`${context}: некорректная кодировка data:-модуля`)
  }
  if (esmStaticImports(parseJs(code, 'inline-module.js')).length > 0) {
    fail(`${context}: статические зависимости data:-модуля не поддерживаются — бюджет посчитать нельзя`)
  }
}

/** URL → ключ файла внутри dist (`assets/index.js`); идентичность файла ≠ URL. */
function keyFromUrl(url, context) {
  const { pathname } = url
  if (!pathname.startsWith(ROOT_MARK)) {
    fail(`${context}: ссылка ${decodeURIComponent(pathname)} выходит за пределы dist`)
  }
  let key
  try {
    key = decodeURIComponent(pathname.slice(ROOT_MARK.length))
  } catch {
    fail(`${context}: некорректный адрес ${pathname}`)
  }
  if (key === '' || key.endsWith('/')) fail(`${context}: адрес не указывает на файл (${pathname})`)
  return key
}

/**
 * Адрес из HTML (`src`, `href`) — обычный URL относительно index.html.
 * Внешний адрес не отбрасывается: посчитать его в бюджете нельзя, значит
 * артефакт непригоден для проверки.
 */
function resolveDocumentUrl(rawUrl, context) {
  const url = rawUrl.trim()
  if (url === '') fail(`${context}: пустой адрес стартового ресурса`)
  if (isExternal(url)) {
    fail(`${context}: стартовый ресурс вне сборки (${url}) — бюджет посчитать нельзя`)
  }
  return keyFromUrl(new URL(url.replace(/^\/+/, ''), ROOT_URL), context)
}

/**
 * Спецификатор модуля из JS. В браузере это не любой URL: работают только
 * относительные и root-relative формы. Bare-спецификатор (`react`) без
 * import map не резолвится, внешний адрес не поддаётся подсчёту — обе формы
 * дают отказ, чтобы бюджет не занижался молча.
 */
function resolveModuleSpecifier(rawSpecifier, importerKey, context) {
  const specifier = rawSpecifier.trim()
  if (specifier === '') fail(`${context}: пустой спецификатор импорта`)
  if (INLINE_MODULE.test(specifier)) {
    validateInlineModule(specifier, context)
    return null
  }
  if (isExternal(specifier)) {
    fail(`${context}: внешний статический импорт (${specifier}) — бюджет посчитать нельзя`)
  }
  if (specifier.startsWith('/')) {
    return keyFromUrl(new URL(specifier.replace(/^\/+/, ''), ROOT_URL), context)
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    fail(`${context}: неподдержанный спецификатор импорта (${specifier}) — бюджет посчитать нельзя`)
  }
  return keyFromUrl(new URL(specifier, `${ROOT_URL}${importerKey}`), context)
}

function assetPath(distDir, key, context) {
  const absolute = resolve(distDir, key)
  const rel = relative(distDir, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    fail(`${context}: ассет ${key} лежит вне ${distDir}`)
  }
  return absolute
}

// --- разбор index.html -------------------------------------------------------

/**
 * Возвращает стартовые ссылки ровно так, как их видит браузер:
 * modern-ветка — модульный entry и modulepreload, legacy-ветка — nomodule
 * polyfills и nomodule entry (у него адрес лежит в data-src, а не в src).
 *
 * HTML разбирается jsdom без исполнения скриптов и без загрузки ресурсов:
 * закомментированный `<script>` — комментарий, а не стартовая зависимость.
 */
export function parseStartupHtml(html) {
  const startup = { modern: [], legacy: [] }
  const dom = new JSDOM(html)
  try {
    for (const element of dom.window.document.querySelectorAll('script, link')) {
      const tag = element.tagName.toLowerCase()
      if (tag === 'link') {
        const rel = (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
        const href = element.getAttribute('href')
        if (rel.includes('modulepreload') && href) {
          startup.modern.push({ url: href, reason: 'modulepreload' })
        }
        continue
      }
      if (element.hasAttribute('nomodule')) {
        const id = element.getAttribute('id')
        const src = element.getAttribute('src')
        const dataSrc = element.getAttribute('data-src')
        if (id === 'vite-legacy-polyfill' && src) {
          startup.legacy.push({ url: src, reason: 'legacy polyfills' })
        }
        if (id === 'vite-legacy-entry' && dataSrc) {
          startup.legacy.push({ url: dataSrc, reason: 'legacy entry' })
        }
        continue
      }
      const src = element.getAttribute('src')
      if ((element.getAttribute('type') ?? '').toLowerCase().trim() === 'module') {
        if (src) {
          startup.modern.push({ url: src, reason: 'entry' })
        } else {
          for (const specifier of esmStaticImports(parseJs(element.textContent, 'inline-html.js'))) {
            // Vite вставляет тот же dependency-free detector ещё и в HTML.
            // Его байты относятся к HTML, не к бюджету отдельных JS-файлов.
            if (!INLINE_MODULE.test(specifier)) {
              fail('index.html: статические импорты inline-модуля не поддерживаются — бюджет посчитать нельзя')
            }
            validateInlineModule(specifier, 'index.html (inline-модуль)')
          }
        }
      }
    }
  } finally {
    dom.window.close()
  }
  return startup
}

// --- разбор статических импортов --------------------------------------------

function parseJs(code, fileName) {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  if (source.parseDiagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, ' ')
    fail(`${fileName}: ошибка разбора JS (${message}) — граф зависимостей не подтверждён`)
  }
  return source
}

/**
 * Статические импорты ES-модуля. Они возможны только на верхнем уровне, поэтому
 * достаточно перебрать statements: `import()` — это вызов, а строка с текстом
 * импорта — литерал, ни то ни другое сюда не попадает.
 */
function esmStaticImports(source) {
  const found = []
  for (const statement of source.statements) {
    const isImport = ts.isImportDeclaration(statement)
    const isReexport = ts.isExportDeclaration(statement)
    if (!isImport && !isReexport) continue
    const specifier = statement.moduleSpecifier
    if (specifier && ts.isStringLiteral(specifier)) found.push(specifier.text)
  }
  return found
}

function isSystemRegister(expression) {
  if (!ts.isPropertyAccessExpression(expression)) return false
  if (expression.name.text !== 'register') return false
  const target = expression.expression
  if (ts.isIdentifier(target)) return target.text === 'System'
  return ts.isPropertyAccessExpression(target) && target.name.text === 'System'
}

/** Список строк `["./a.js", …]` — иначе это не список зависимостей модуля. */
function dependencyList(node) {
  if (!node || !ts.isArrayLiteralExpression(node)) return null
  const deps = []
  for (const element of node.elements) {
    if (!ts.isStringLiteral(element)) return null
    deps.push(element.text)
  }
  return deps
}

/**
 * Зависимости legacy-чанка: первый аргумент `System.register([...], fn)`
 * (или второй — у именованной формы `System.register("name", [...], fn)`).
 * Обход итеративный: минифицированный бандл бывает глубоко вложенным, рекурсия
 * по AST на нём может упереться в стек.
 */
function systemRegisterDeps(source) {
  const found = []
  const stack = [source]
  while (stack.length > 0) {
    const node = stack.pop()
    if (ts.isCallExpression(node) && isSystemRegister(node.expression)) {
      const [first, second] = node.arguments
      const deps = dependencyList(first) ?? (first && ts.isStringLiteral(first) ? dependencyList(second) : null)
      if (deps) found.push(...deps)
    }
    // Дети кладутся в обратном порядке, чтобы обход шёл по порядку исходника:
    // отчёт и тесты не должны зависеть от порядка снятия со стека.
    const children = []
    ts.forEachChild(node, (child) => {
      children.push(child)
    })
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i])
  }
  return found
}

export function staticImportsOf(code, kind) {
  const source = parseJs(code, kind === 'legacy' ? 'chunk-legacy.js' : 'chunk.js')
  return kind === 'legacy' ? systemRegisterDeps(source) : esmStaticImports(source)
}

// --- обход графа -------------------------------------------------------------

function readAsset(absolutePath, key, context) {
  try {
    return readFileSync(absolutePath)
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${context}: ассет ${key} отсутствует в сборке`)
    throw error
  }
}

/**
 * Считает ветку от её стартовых ссылок вглубь по статическим импортам.
 * Повторная встреча файла только добавляет причину включения — размер
 * учитывается один раз, поэтому цикл A→B→A, общая зависимость двух чанков и
 * два адреса одного файла (`x.js` и `x.js?v=1`) не завышают сумму и не
 * зацикливают обход.
 */
export function collectBranch(distDir, seeds, kind) {
  const label = BRANCH_LABELS[kind]
  const counted = new Map()
  const queue = seeds
    .map((seed) => ({
      key: resolveDocumentUrl(seed.url, `${label} (${seed.reason})`),
      reason: seed.reason,
    }))
    .filter((item) => item.key !== null)
  while (queue.length > 0) {
    const { key, reason } = queue.shift()
    const seen = counted.get(key)
    if (seen) {
      seen.reasons.add(reason)
      continue
    }
    const context = `${label} (${reason})`
    const bytes = readAsset(assetPath(distDir, key, context), key, context)
    counted.set(key, { path: key, gzip: gzipSync(bytes).byteLength, reasons: new Set([reason]) })
    for (const specifier of staticImportsOf(bytes.toString('utf8'), kind)) {
      const target = resolveModuleSpecifier(specifier, key, `${label} (статический импорт из ${key})`)
      if (target !== null) queue.push({ key: target, reason: 'статический импорт' })
    }
  }
  return [...counted.values()]
    .map((file) => ({ path: file.path, gzip: file.gzip, reasons: [...file.reasons] }))
    .sort((a, b) => b.gzip - a.gzip || a.path.localeCompare(b.path))
}

// --- отчёт -------------------------------------------------------------------

export function analyzeStartupBundles({ distDir = join(root, 'dist'), budgets = DEFAULT_BUDGETS } = {}) {
  const htmlPath = join(distDir, 'index.html')
  let html
  try {
    html = readFileSync(htmlPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') fail(`нет ${htmlPath} — сначала выполните npm run build`)
    throw error
  }
  const startup = parseStartupHtml(html)
  // modulepreload не заменяет entry: без модульного скрипта современная ветка
  // не стартует, а preload только греет кэш.
  if (!startup.modern.some((seed) => seed.reason === 'entry')) {
    fail('в index.html нет модульного entry — артефакт сборки некорректен')
  }
  const legacyReasons = new Set(startup.legacy.map((seed) => seed.reason))
  // Целевой T2 (Android 7.1) грузит именно nomodule-ветку: её пропажа — не
  // «экономия бюджета», а потеря поддержки терминала.
  if (!legacyReasons.has('legacy polyfills') || !legacyReasons.has('legacy entry')) {
    fail('в index.html нет legacy-ветки (polyfills + entry) — артефакт сборки некорректен')
  }

  const branches = ['modern', 'legacy'].map((kind) => {
    const files = collectBranch(distDir, startup[kind], kind)
    const total = files.reduce((sum, file) => sum + file.gzip, 0)
    const budget = budgets[kind]
    return { kind, label: BRANCH_LABELS[kind], files, total, budget, ok: total <= budget }
  })

  return {
    distDir,
    htmlPath,
    branches,
    ok: branches.every((branch) => branch.ok),
  }
}

export function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB gzip`
}

export function formatReport(report) {
  const lines = []
  for (const branch of report.branches) {
    lines.push(
      `${branch.ok ? 'OK' : 'OVER'} ${branch.label}: ${kib(branch.total)} / ${kib(branch.budget)}` +
        ` (${branch.files.length} файл(ов))`,
    )
    for (const file of branch.files) {
      lines.push(`     ${kib(file.gzip).padStart(16)}  ${file.path}  [${file.reasons.join(', ')}]`)
    }
  }
  return lines
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dist') {
      const value = argv[i + 1]
      if (!value) fail('--dist требует путь к каталогу сборки')
      options.distDir = resolve(process.cwd(), value)
      i += 1
      continue
    }
    fail(`неизвестный аргумент: ${argv[i]}`)
  }
  return options
}

export function main(argv = []) {
  let report
  try {
    report = analyzeStartupBundles(parseArgs(argv))
  } catch (error) {
    if (error instanceof BundleCheckError) {
      console.error(`FAIL check-bundle-size: ${error.message}`)
      return 1
    }
    throw error
  }
  for (const line of formatReport(report)) console.log(line)
  return report.ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
