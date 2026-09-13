// Explicitly disposable LOCAL database only. Seeds synthetic users/workspaces;
// leave the fixtures for inspection and drop the disposable database afterwards.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

const database = process.argv[2]
if (!/^angle_onboarding_a4_[a-z0-9_]+$/.test(database || '')) {
  throw new Error('Usage: node scripts/test-onboarding-concurrency.mjs angle_onboarding_a4_<disposable_suffix>')
}
if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')) {
  throw new Error('Remote Docker is not allowed')
}
const container = 'supabase_db_kassa'
const prefix = `a4_${randomUUID().replaceAll('-', '').slice(0, 16)}`
const children = new Set()
function connection(app) {
  const child = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${app}`, container,
    'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], { stdio: 'pipe' })
  children.add(child)
  let output = '', error = ''
  child.stdout.on('data', (part) => { output += part })
  child.stderr.on('data', (part) => { error += part })
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${app}`)) }, 25000)
    child.on('error', (failure) => { clearTimeout(timer); reject(failure) })
    child.on('close', (code) => { clearTimeout(timer); children.delete(child); resolve({ code, output, error }) })
  })
  return { child, done, output: () => output }
}
async function sql(statement) {
  const c = connection(`${prefix}_check`)
  c.child.stdin.end(statement)
  const result = await c.done
  assert.equal(result.code, 0, result.error)
  return result.output.trim()
}
async function until(check) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('Both transactions did not reach the lock barrier')
}
let triggerCreated = false
try {
  const context = spawn('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let endpoint = ''
  context.stdout.on('data', (part) => { endpoint += part })
  await new Promise((resolve, reject) => { context.on('error', reject); context.on('close', (code) => code === 0 ? resolve() : reject(new Error('Docker context check failed'))) })
  assert.ok(endpoint.trim().startsWith('unix://'), 'Only a local Unix-socket Docker context is allowed')
  assert.equal(await sql('SELECT current_database();'), database)
  // This trigger pauses INSERT *after* the legacy absence check. Both clients
  // can reach it before the old UPDATE auth.users, making the old race repeatable.
  await sql(`CREATE FUNCTION ${prefix}_pause() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.name LIKE '${prefix}%' THEN
      PERFORM pg_advisory_xact_lock(165, 165);
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER ${prefix}_pause BEFORE INSERT ON orgs FOR EACH ROW EXECUTE FUNCTION ${prefix}_pause();`)
  triggerCreated = true
  const cases = [
    { name: 'baseline_unlocked', calls: ['unlocked', 'unlocked'], orgs: 2, errors: 0 },
    { name: 'legacy_digital', calls: ['digital', 'digital'], orgs: 1, errors: 1 },
    { name: 'digital_and_pos', calls: ['digital', 'pos'], orgs: 1, errors: 1 },
    { name: 'same_request', calls: ['request', 'request'], orgs: 1, errors: 0 },
    { name: 'different_requests', calls: ['request', 'different'], orgs: 1, errors: 1 },
  ]
  for (const test of cases) {
    const user = randomUUID(), request = randomUUID(), name = `${prefix}_${test.name}`
    await sql(`INSERT INTO auth.users(id,email) VALUES ('${user}', '${user}@example.test');`)
    const gate = connection(`${prefix}_gate`)
    // Keep the coordinator session open; its advisory lock is the test barrier.
    gate.child.stdin.write("SELECT pg_advisory_lock(165,165); SELECT 'gate_held';\n")
    const workers = []
    try {
      await until(() => gate.output().includes('gate_held'))
      for (const [index, kind] of test.calls.entries()) {
        const fn = kind === 'unlocked' ? `bootstrap_digital_org_unlocked_165('${name}','Main',NULL,ARRAY['menu'])`
          : kind === 'digital' ? `bootstrap_digital_org('${name}','Main',NULL,ARRAY['menu'])`
            : kind === 'pos' ? `bootstrap_org('${name}','Main','Owner','1234')`
              : `create_digital_workspace('${kind === 'different' ? randomUUID() : request}','${name}','Main',ARRAY['menu'])`
        const c = connection(`${prefix}_worker${index}`)
        c.child.stdin.end(`BEGIN; SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '12s';
          ${kind === 'unlocked' ? '' : 'SET LOCAL ROLE authenticated;'}
          SET LOCAL request.jwt.claims = '{"sub":"${user}","role":"authenticated"}';
          SELECT ${fn}; COMMIT;`)
        workers.push(c)
      }
      await until(async () => Number(await sql(`SELECT count(*) FROM pg_stat_activity
        WHERE application_name IN ('${prefix}_worker0','${prefix}_worker1') AND wait_event_type = 'Lock';`)) === 2)
      gate.child.stdin.end('SELECT pg_advisory_unlock(165,165);')
      const results = await Promise.all(workers.map((worker) => worker.done))
      assert.equal(results.filter((result) => result.code !== 0).length, test.errors, JSON.stringify(results))
      for (const result of results.filter((result) => result.code !== 0)) assert.match(result.error, /org already bootstrapped/)
      assert.equal(Number(await sql(`SELECT count(*) FROM orgs WHERE name = '${name}';`)), test.orgs, test.name)
      assert.equal(Number(await sql(`SELECT count(*) FROM locations WHERE org_id IN (SELECT id FROM orgs WHERE name = '${name}');`)), test.orgs)
      assert.equal(Number(await sql(`SELECT count(*) FROM organization_products WHERE org_id IN (SELECT id FROM orgs WHERE name = '${name}');`)), 0)
      if (test.name === 'same_request') assert.deepEqual(JSON.parse(results[0].output), JSON.parse(results[1].output))
      console.log(`PASS ${test.name}: ${test.orgs} workspace(s), ${test.errors} rejected request(s)`)
    } finally {
      if (!gate.child.stdin.writableEnded) gate.child.stdin.end('SELECT pg_advisory_unlock(165,165);')
      await gate.done
      await Promise.all(workers.map((worker) => worker.done))
    }
  }
} finally {
  if (triggerCreated) await sql(`DROP TRIGGER ${prefix}_pause ON orgs; DROP FUNCTION ${prefix}_pause();`)
  for (const child of children) child.kill()
}
