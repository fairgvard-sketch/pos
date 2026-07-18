// Сверяет MIN_SCHEMA_VERSION фронтенда с номером последней миграции.
//
// Порядок релиза «миграции → функции → фронт» гарантирует, что база не отстаёт
// от выложенного фронта, поэтому константа обязана равняться последней
// миграции: новая миграция без бампа константы (или наоборот) роняет CI.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const migrations = readdirSync(join(root, 'supabase/migrations')).filter((f) =>
  /^\d+_.*\.sql$/.test(f),
)
if (migrations.length === 0) {
  console.error('check-schema-version: не найдено ни одной миграции')
  process.exit(1)
}
const latest = Math.max(...migrations.map((f) => parseInt(f, 10)))

const src = readFileSync(join(root, 'src/lib/schemaVersion.ts'), 'utf8')
const match = src.match(/MIN_SCHEMA_VERSION\s*=\s*(\d+)/)
if (!match) {
  console.error('check-schema-version: MIN_SCHEMA_VERSION не найдена в src/lib/schemaVersion.ts')
  process.exit(1)
}
const min = Number(match[1])

if (min !== latest) {
  console.error(
    `check-schema-version: MIN_SCHEMA_VERSION=${min}, а последняя миграция — ${latest}. ` +
      'Обновите константу в src/lib/schemaVersion.ts вместе с миграцией.',
  )
  process.exit(1)
}
console.log(`check-schema-version: ok (v${latest})`)
