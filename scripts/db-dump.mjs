#!/usr/bin/env node
/**
 * Логический бэкап production (P1-8): roles + schema + data одним прогоном
 * в backups/<дата>/ (каталог в .gitignore, в репозиторий не попадает).
 * Относительно прода операция read-only. Восстановление — docs/backups.md.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stamp = new Date().toISOString().slice(0, 10)
const dir = join(root, 'backups', stamp)
mkdirSync(dir, { recursive: true })

const dumps = [
  [['--role-only'], 'roles.sql'],
  [[], 'schema.sql'],
  [['--data-only', '--use-copy'], 'data.sql'],
]
for (const [flags, file] of dumps) {
  console.log(`→ supabase db dump --linked ${flags.join(' ')} → backups/${stamp}/${file}`)
  execFileSync('npx', ['supabase', 'db', 'dump', '--linked', ...flags, '-f', join(dir, file)], {
    stdio: 'inherit',
    cwd: root,
  })
}

console.log(`\n✓ Дамп готов: backups/${stamp}/`)
console.log('  Файлы Storage (фото меню, логотипы) в дамп НЕ входят — см. docs/backups.md.')
console.log('  Копию хранить вне этой машины и зашифрованной: внутри PIN-хэши и данные гостей.')
