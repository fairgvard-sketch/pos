import { gzipSync } from 'node:zlib'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const assetsDir = new URL('../dist/assets/', import.meta.url)
const files = readdirSync(assetsDir)

function findOne(pattern, label) {
  const matches = files.filter((name) => pattern.test(name))
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one asset, found ${matches.length} (${matches.join(', ')})`)
  }
  return matches[0]
}

function gzipBytes(name) {
  return gzipSync(readFileSync(join(assetsDir.pathname, name))).byteLength
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB gzip`
}

const modernEntry = findOne(/^index-(?!legacy-).+\.js$/, 'modern entry')
const legacyEntry = findOne(/^index-legacy-.+\.js$/, 'legacy entry')
const legacyPolyfills = findOne(/^polyfills-legacy-.+\.js$/, 'legacy polyfills')

const budgets = [
  {
    label: 'modern entry',
    files: [modernEntry],
    actual: gzipBytes(modernEntry),
    max: 240 * 1024,
  },
  {
    label: 'legacy startup JS',
    files: [legacyPolyfills, legacyEntry],
    actual: gzipBytes(legacyPolyfills) + gzipBytes(legacyEntry),
    max: 310 * 1024,
  },
]

let failed = false
for (const budget of budgets) {
  const ok = budget.actual <= budget.max
  console.log(`${ok ? 'OK' : 'OVER'} ${budget.label}: ${kib(budget.actual)} / ${kib(budget.max)} (${budget.files.join(' + ')})`)
  failed ||= !ok
}

if (failed) process.exitCode = 1
