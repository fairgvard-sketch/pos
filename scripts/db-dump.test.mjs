import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createBackup } from './db-dump.mjs'

function setup(t, handler) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'angle-dump-test-'))
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }))
  const calls = []
  const options = { projectRoot, now: () => new Date('2026-09-13T12:00:00Z'), log: () => {},
    run: (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      if (handler?.(cmd, args, opts) === false) return
      if (cmd === 'npx') writeFileSync(args.at(-1), '-- PostgreSQL database dump complete\n')
    } }
  return { options, calls, projectRoot }
}

test('same-time backups are distinct and never overwrite a prior file', t => {
  const { options } = setup(t)
  const a = createBackup(options), b = createBackup(options)
  assert.notEqual(a.dir, b.dir)
  assert.equal(readFileSync(join(a.dir, 'data.sql'), 'utf8'), '-- PostgreSQL database dump complete\n')
})
test('directory, dumps and completion manifest are private', t => {
  const { options } = setup(t)
  const { dir } = createBackup(options)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  for (const name of ['roles.sql', 'schema.sql', 'data.sql', 'manifest.json']) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600)
})
test('manifest certifies exact bytes, not restore or Storage coverage', t => {
  const { options } = setup(t)
  const { dir, manifest } = createBackup(options)
  assert.equal(manifest.status, 'complete')
  assert.equal(manifest.restoreTested, false)
  assert.equal(manifest.storageObjectsIncluded, false)
  for (const file of manifest.files) {
    const data = readFileSync(join(dir, file.name))
    assert.equal(file.bytes, data.length)
    assert.equal(file.sha256, createHash('sha256').update(data).digest('hex'))
  }
})
test('direct call runs project-ref guard before any dump', t => {
  const { options, calls } = setup(t)
  createBackup(options)
  assert.equal(calls[0].cmd, process.execPath)
  assert.match(calls[0].args[0], /check-project-ref\.mjs$/)
  assert.equal(calls.length, 4)
  assert.ok(calls.slice(1).every(c => c.args.includes('--linked') && c.opts.timeout > 0 && c.opts.stdio === 'pipe'))
  assert.ok(calls.at(-1).args.includes('--use-copy'))
})
test('guard failure creates no backup and does not leak child stderr', t => {
  const { options, projectRoot } = setup(t, () => { throw new Error('private-token') })
  assert.throws(() => createBackup(options), error => !error.message.includes('private-token') && /guard failed/.test(error.message))
  assert.deepEqual(readdirSync(projectRoot), [])
})
test('failed dump retains private partials without completion manifest', t => {
  const { options, projectRoot } = setup(t, (cmd, args) => {
    if (cmd === 'npx' && args.at(-1).endsWith('data.sql')) throw new Error('private-token')
  })
  const before = process.umask()
  assert.throws(() => createBackup(options), error => !error.message.includes('private-token') && /incomplete/.test(error.message))
  assert.equal(process.umask(), before)
  const dir = join(projectRoot, 'backups', readdirSync(join(projectRoot, 'backups'))[0])
  assert.ok(!readdirSync(dir).includes('manifest.json'))
  assert.equal(statSync(join(dir, 'data.sql')).mode & 0o777, 0o600)
})
test('empty output with exit zero is not complete', t => {
  const { options } = setup(t, cmd => cmd === 'npx' ? false : undefined)
  assert.throws(() => createBackup(options), /incomplete/)
})
test('truncated output with exit zero is not complete', t => {
  const { options } = setup(t, (cmd, args) => {
    if (cmd === 'npx') { writeFileSync(args.at(-1), '-- unfinished\n'); return false }
  })
  assert.throws(() => createBackup(options), /incomplete/)
})
test('an existing backups symlink cannot redirect sensitive output', t => {
  const { options, projectRoot } = setup(t)
  mkdirSync(join(projectRoot, 'elsewhere'))
  symlinkSync(join(projectRoot, 'elsewhere'), join(projectRoot, 'backups'))
  assert.throws(() => createBackup(options), /real directory/)
  assert.deepEqual(readdirSync(join(projectRoot, 'elsewhere')), [])
})

test('Supabase schema without pg_dump footer and commented data unrestrict are supported', t => {
  const { options } = setup(t, (cmd, args) => {
    if (cmd !== 'npx') return
    const name = args.at(-1)
    const text = name.endsWith('schema.sql') ? 'CREATE TABLE sample(id int);\nRESET ALL;\n'
      : name.endsWith('data.sql') ? '-- PostgreSQL database dump complete\n--\n-- \\unrestrict example\n\nRESET ALL;\n' : '-- no custom roles\n'
    writeFileSync(name, text)
    return false
  })
  assert.equal(createBackup(options).manifest.status, 'complete')
})

test('a data completion marker followed by more SQL is not a complete footer', t => {
  const { options } = setup(t, (cmd, args) => {
    if (cmd === 'npx') { writeFileSync(args.at(-1), '-- PostgreSQL database dump complete\nCOPY unfinished'); return false }
  })
  assert.throws(() => createBackup(options), /incomplete/)
})
