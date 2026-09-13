#!/usr/bin/env node
// Read-only towards production. A completed dump is NOT a restore test or PITR.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dumps = [
  [['--role-only'], 'roles.sql'],
  [[], 'schema.sql'],
  [['--data-only', '--use-copy'], 'data.sql'],
]

export function createBackup({ projectRoot = root, run = execFileSync, now = () => new Date(), log = console.log } = {}) {
  // Guard also runs when someone calls this file directly, not just via npm.
  try {
    run(process.execPath, [join(projectRoot, 'scripts/check-project-ref.mjs')],
      { cwd: projectRoot, stdio: 'pipe', timeout: 15000 })
  } catch {
    throw new Error('Project-ref guard failed; no backup created. Run npm run check:ref for details.')
  }
  const startedAt = now().toISOString()
  const base = join(projectRoot, 'backups')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  if (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()) throw new Error('backups must be a real directory')
  // mkdtemp is atomic: same-day and simultaneous runs never share files.
  const dir = mkdtempSync(join(base, startedAt.replaceAll(':', '-') + '-'))
  chmodSync(dir, 0o700)
  const files = []
  const previousUmask = process.umask(0o077)
  try {
    for (const [flags, name] of dumps) {
      const path = join(dir, name)
      closeSync(openSync(path, 'wx', 0o600))
      log(`Dump ${name} → ${dir}`)
      run('npx', ['supabase', 'db', 'dump', '--linked', ...flags, '-f', path],
        { cwd: projectRoot, stdio: 'pipe', timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Invalid dump output')
      chmodSync(path, 0o600)
      const data = readFileSync(path)
      // Supabase strips pg_dump comments from schema output; role-only can
      // contain only comments. The COPY data dump retains the completion
      // footer, optionally followed by comments (\unrestrict) and RESET ALL.
      if (name === 'data.sql') {
        const text = data.toString('utf8').replaceAll('\r\n', '\n')
        const marker = '-- PostgreSQL database dump complete\n'
        const index = text.lastIndexOf(marker)
        const tail = index < 0 ? [] : text.slice(index + marker.length).split('\n')
        if (index < 0 || tail.some(line => line.trim() && !line.startsWith('--') && line.trim() !== 'RESET ALL;')) {
          throw new Error('Incomplete dump output')
        }
      }
      files.push({ name, bytes: stat.size, sha256: createHash('sha256').update(data).digest('hex') })
    }
    const manifest = { format: 1, status: 'complete', startedAt, completedAt: now().toISOString(),
      storageObjectsIncluded: false, restoreTested: false, files }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    log(`Dump complete: ${dir}/manifest.json. Storage files and off-site protection are separate.`)
    return { dir, manifest }
  } catch {
    // Child stderr can contain credentials or SQL rows. Never print it/cause.
    throw new Error(`Backup incomplete: ${dir}. No completion manifest; existing backups are untouched. Private partial files retained.`)
  } finally {
    process.umask(previousUmask)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { createBackup() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
