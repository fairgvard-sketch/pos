// Guard tests for the telemetry concurrency driver. Pure unit checks: they
// never open a connection, so they are safe without Docker.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertDisposableDatabase, DATABASE_GUARD, parseAccepted } from './test-telemetry-ingest-concurrency.mjs'

test('accepts a disposable fixture database', () => {
  assert.equal(assertDisposableDatabase('kassa_f62_after170'), 'kassa_f62_after170')
  assert.equal(assertDisposableDatabase('kassa_f62_x1'), 'kassa_f62_x1')
})

test('refuses shared and production-shaped databases', () => {
  for (const name of ['postgres', 'template1', '_supabase', 'kassa', 'angle_billing_lab_a5',
    'KASSA_F62_UPPER', 'kassa_f62_', 'other_kassa_f62_x', 'kassa_f62_x; DROP DATABASE kassa']) {
    assert.throws(() => assertDisposableDatabase(name), /Refusing database/, `must refuse ${name}`)
  }
})

test('refuses a missing database argument', () => {
  assert.throws(() => assertDisposableDatabase(undefined), /Refusing database/)
  assert.throws(() => assertDisposableDatabase(''), /Refusing database/)
})

test('guard is anchored at both ends', () => {
  assert.equal(DATABASE_GUARD.source.startsWith('^'), true)
  assert.equal(DATABASE_GUARD.source.endsWith('$'), true)
})

test('reads the accepted count from real psql output', () => {
  assert.equal(parseAccepted('\nrpc:0\n'), 0)
  assert.equal(parseAccepted('\nrpc:1\n'), 1)
  assert.equal(parseAccepted('rpc:20'), 20)
})

test('refuses output without an rpc line instead of assuming zero', () => {
  // A silent worker (killed, timed out, stubbed) must not read as "accepted 0":
  // that is exactly how a lost event turns into a false PASS.
  for (const output of ['', '\n\n', 'ERROR:  device_not_registered', 'rpc:', 'rpcx:1']) {
    assert.throws(() => parseAccepted(output), /No rpc: line/, `must refuse ${JSON.stringify(output)}`)
  }
})
