// Telemetry ingest limits under real concurrency (F6.2).
//
// pgTAP runs one transaction, so it cannot observe two clients racing between
// the daily-fingerprint COUNT and the INSERT. This driver opens separate psql
// connections, parks them on a shared starting-line lock and releases them
// together, then checks the surviving state.
//
// The checks are exact on purpose. An earlier version only asserted
// `rows > 100`, which a mutant that loses BOTH new events (`v_today >= 99`)
// still satisfied: nothing was written, so nothing exceeded the ceiling.
// Every scenario now pins the state before and after, the value each RPC
// returned on its own connection, and the survival of the existing rows.
//
// Explicitly disposable LOCAL database only: the name guard below is the only
// database this script will ever touch, and it neither creates nor drops it.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

export const DATABASE_GUARD = /^kassa_f62_[a-z0-9_]+$/

/** Exported for the guard test: refuse anything that is not our fixture. */
export function assertDisposableDatabase(name) {
  if (!DATABASE_GUARD.test(name || '')) {
    throw new Error(`Refusing database '${name}': expected kassa_f62_<disposable_suffix>`)
  }
  return name
}

/** Exported for the guard test: the accepted count must come from real psql output. */
export function parseAccepted(output) {
  const found = /(?:^|\n)rpc:(\d+)(?:\r?\n|$)/.exec(output)
  if (!found) throw new Error(`No rpc: line in worker output: ${JSON.stringify(output)}`)
  return Number(found[1])
}

const GATE = 620001          // starting line: released when both workers wait
const PAUSE = 620002         // inside the insert trigger: widens the race window
const ORG = '50000000-0000-4000-8000-000000000001'
const LOCATION = '51000000-0000-4000-8000-000000000001'
const USER = '52000000-0000-4000-8000-000000000001'
const DEVICE = '53000000-0000-4000-8000-000000000001'

const container = process.env.TELEMETRY_DB_CONTAINER || 'supabase_db_kassa'
const children = new Set()

function connection(database, app) {
  const child = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${app}`, container,
    'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], { stdio: 'pipe' })
  children.add(child)
  let output = '', error = ''
  child.stdout.on('data', (part) => { output += part })
  child.stderr.on('data', (part) => { error += part })
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${app}`)) }, 30000)
    child.on('error', (failure) => { clearTimeout(timer); reject(failure) })
    child.on('close', (code) => { clearTimeout(timer); children.delete(child); resolve({ code, output, error }) })
  })
  return { child, done, output: () => output }
}

async function main(database) {
  assertDisposableDatabase(database)
  const context = spawn('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let endpoint = ''
  context.stdout.on('data', (part) => { endpoint += part })
  await new Promise((resolve, reject) => {
    context.on('error', reject)
    context.on('close', (code) => code === 0 ? resolve() : reject(new Error('Docker context check failed')))
  })
  assert.ok(endpoint.trim().startsWith('unix://'), 'Only a local Unix-socket Docker context is allowed')

  const sql = async (statement) => {
    const c = connection(database, `f62_check_${randomUUID().slice(0, 8)}`)
    c.child.stdin.end(statement)
    const result = await c.done
    assert.equal(result.code, 0, result.error)
    return result.output.trim()
  }
  assert.equal(await sql('SELECT current_database();'), database)

  const until = async (check, what) => {
    const deadline = Date.now() + 15000
    let last = ''
    while (Date.now() < deadline) {
      last = await check()
      if (last === true || last === '') return
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw new Error(`Workers never reached: ${what}${last && last !== true ? ` (last state: ${last})` : ''}`)
  }

  // Synthetic fixture, seeded here so the script runs against any freshly
  // migrated disposable database. Device identity matches register_device
  // (169): org + location + auth_user_id.
  await sql(`INSERT INTO orgs(id,name) VALUES ('${ORG}','F62 concurrency org') ON CONFLICT DO NOTHING;
    INSERT INTO locations(id,org_id,name) VALUES ('${LOCATION}','${ORG}','F62 point') ON CONFLICT DO NOTHING;
    INSERT INTO auth.users(id) VALUES ('${USER}') ON CONFLICT DO NOTHING;
    INSERT INTO devices(org_id,location_id,name,device_uuid,auth_user_id,settings)
      VALUES ('${ORG}','${LOCATION}','F62 till','${DEVICE}','${USER}','{}') ON CONFLICT DO NOTHING;`)

  // The pause trigger holds every INSERT until the coordinator lets go, so the
  // window between the daily COUNT and the INSERT stays open for both workers.
  await sql(`CREATE OR REPLACE FUNCTION f62_pause() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${PAUSE}); RETURN NEW; END $$;`)

  // The per-org+device advisory key the function itself takes (170). Waiting on
  // THIS key — or on the insert pause — is what proves a worker is inside the
  // contested section; waiting on GATE only proves it is still at the barrier.
  const [pairClass, pairObject] = (await sql(
    `SELECT ((hashtextextended('${ORG}/${DEVICE}',0) >> 32) & 4294967295)::TEXT || ' ' ||
            (hashtextextended('${ORG}/${DEVICE}',0) & 4294967295)::TEXT;`)).split(' ')

  // Where each live worker actually is: the wait is classified by its concrete
  // lock, and `past_gate` is read from the granted shared lock on the barrier.
  const stateQuery = `SELECT string_agg(line, ' ' ORDER BY line) FROM (
      SELECT a.application_name || '=' || CASE
          WHEN l.pid IS NULL THEN 'running'
          WHEN l.locktype = 'advisory' AND l.classid = 0 AND l.objid = ${GATE} THEN 'gate'
          WHEN l.locktype = 'advisory' AND l.classid = 0 AND l.objid = ${PAUSE} THEN 'pause'
          WHEN l.locktype = 'advisory' AND l.classid = ${pairClass} AND l.objid = ${pairObject} THEN 'pair'
          WHEN l.locktype IN ('transactionid','tuple') THEN 'row'
          ELSE 'other:' || l.locktype || '/' || COALESCE(l.classid::TEXT,'-') || '/' || COALESCE(l.objid::TEXT,'-')
        END || CASE WHEN g.pid IS NULL THEN '/at_gate' ELSE '/past_gate' END AS line
      FROM pg_stat_activity a
      LEFT JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
      LEFT JOIN pg_locks g ON g.pid = a.pid AND g.granted AND g.locktype = 'advisory'
        AND g.classid = 0 AND g.objid = ${GATE} AND g.mode = 'ShareLock'
      WHERE a.application_name IN ('f62_worker0','f62_worker1')
    ) states;`
  // The coordinator's exclusive hold on the barrier: 1 while closed, 0 once open.
  const gateHeldQuery = `SELECT count(*) FROM pg_locks
    WHERE locktype = 'advisory' AND classid = 0 AND objid = ${GATE}
      AND granted AND mode = 'ExclusiveLock';`

  // TELEMETRY_TRACE=1 prints the observed worker states, so a run can show
  // WHICH lock proved the workers were inside the contested section.
  const trace = (line) => { if (process.env.TELEMETRY_TRACE) console.log(`TRACE ${line}`) }

  const results = []
  const record = (tag, ok, detail) => {
    results.push({ tag, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${tag}: ${detail}`)
  }

  try {
    for (const scenario of ['new_fingerprints_at_99', 'same_fingerprint_repeat']) {
      for (const attempt of [1, 2]) {
        const tag = `${scenario}#${attempt}`
        const day = `${randomUUID().slice(0, 8)}`
        await sql(`DELETE FROM client_errors WHERE org_id = '${ORG}';`)
        if (scenario === 'new_fingerprints_at_99') {
          await sql(`INSERT INTO client_errors(org_id,location_id,device_uuid,fingerprint,source,message)
            SELECT '${ORG}','${LOCATION}','${DEVICE}','seed_${day}_'||i,'react','m' FROM generate_series(1,99) i;`)
        } else {
          await sql(`INSERT INTO client_errors(org_id,location_id,device_uuid,fingerprint,source,message,count)
            VALUES ('${ORG}','${LOCATION}','${DEVICE}','hot_${day}','react','m',1);`)
        }
        const state = async () => sql(`SELECT count(*)||'|'||coalesce(sum(count),0) FROM client_errors
          WHERE org_id='${ORG}' AND device_uuid='${DEVICE}' AND day=CURRENT_DATE;`)
        const before = await state()
        // The starting state is pinned, not assumed: a scenario that begins
        // anywhere other than exactly 99 (or exactly 1) proves nothing.
        assert.equal(before, scenario === 'new_fingerprints_at_99' ? '99|99' : '1|1',
          `${tag}: unexpected starting state ${before}`)

        await sql(`CREATE TRIGGER f62_pause BEFORE INSERT ON client_errors
          FOR EACH ROW EXECUTE FUNCTION f62_pause();`)
        const gate = connection(database, 'f62_gate')
        gate.child.stdin.write(`SELECT pg_advisory_lock(${GATE}); SELECT pg_advisory_lock(${PAUSE}); SELECT 'gate_held';\n`)
        const workers = []
        try {
          await until(async () => gate.output().includes('gate_held'), 'coordinator lock')
          const payloads = scenario === 'new_fingerprints_at_99'
            ? [`[{"fingerprint":"race_a_${day}","source":"react","message":"m"}]`,
               `[{"fingerprint":"race_b_${day}","source":"react","message":"m"}]`]
            : [`[{"fingerprint":"hot_${day}","source":"react","message":"m","count":3}]`,
               `[{"fingerprint":"hot_${day}","source":"react","message":"m","count":4}]`]
          if (scenario === 'new_fingerprints_at_99') {
            assert.notEqual(payloads[0], payloads[1], 'both workers must send different new fingerprints')
          }
          for (const [index, payload] of payloads.entries()) {
            const c = connection(database, `f62_worker${index}`)
            // Shared lock on GATE: both workers unblock together when the
            // coordinator releases it, so neither gets a head start. The lock
            // is held for the whole transaction, which is what `past_gate`
            // above reads back.
            c.child.stdin.end(`BEGIN; SET LOCAL statement_timeout = '25s'; SET LOCAL lock_timeout = '20s';
              SET LOCAL ROLE authenticated;
              SET LOCAL request.jwt.claims = '{"sub":"${USER}","role":"authenticated","app_metadata":{"org_id":"${ORG}","location_id":"${LOCATION}"}}';
              SELECT pg_advisory_xact_lock_shared(${GATE});
              SELECT 'rpc:'||report_client_errors('${DEVICE}', '${payload}'::jsonb); COMMIT;`)
            workers.push(c)
          }
          // Starting line: both workers must be blocked on GATE specifically.
          await until(async () => {
            const line = await sql(stateQuery)
            if ((line.match(/=gate\/at_gate/g) || []).length !== 2) return line
            trace(`${tag} starting line: ${line}`)
            return true
          }, 'starting line (both blocked on the barrier)')
          gate.child.stdin.write(`SELECT pg_advisory_unlock(${GATE});\n`)
          // Contested section: the barrier is confirmed open, and every worker
          // either finished or is past the barrier waiting on a CONCRETE lock
          // of the disputed path — the insert pause, the function's own
          // org+device key, or a row conflict. Still waiting on GATE does not
          // count: that is the barrier, not the COUNT → INSERT window.
          await until(async () => {
            const held = await sql(gateHeldQuery)
            const line = await sql(stateQuery)
            const inside = (line.match(/=(pause|pair|row)\/past_gate/g) || []).length
            const finished = workers.filter((w) => !children.has(w.child)).length
            if (!(held === '0' && inside + finished === 2)) return `gate_held=${held} ${line}`
            trace(`${tag} contested: gate_held=${held} inside=${inside} finished=${finished} ${line}`)
            return true
          }, 'contested section (past the barrier, on the disputed locks)')
          gate.child.stdin.end(`SELECT pg_advisory_unlock(${PAUSE});`)
          const finished = await Promise.all(workers.map((w) => w.done))
          for (const result of finished) assert.equal(result.code, 0, `worker failed: ${result.error}`)
          // Accepted counts come from the workers' own connections.
          const accepted = finished.map((result) => parseAccepted(result.output))
          const acceptedTotal = accepted.reduce((sum, value) => sum + value, 0)

          const after = await state()
          const [rows, total] = after.split('|').map(Number)
          const detail = `before=${before} after=${after} rpc=[${accepted.join(',')}]`
          if (scenario === 'new_fingerprints_at_99') {
            // Exactly one of the two new fingerprints may land: 99 + 1 = 100.
            // Both landing means the ceiling leaked; neither landing means the
            // limit swallowed a slot that was still free.
            const newRows = Number(await sql(`SELECT count(*) FROM client_errors
              WHERE org_id='${ORG}' AND fingerprint IN ('race_a_${day}','race_b_${day}');`))
            const seedRows = Number(await sql(`SELECT count(*) FROM client_errors
              WHERE org_id='${ORG}' AND fingerprint LIKE 'seed_${day}_%';`))
            const problems = []
            if (rows !== 100) problems.push(rows > 100
              ? `daily limit exceeded (${rows} > 100)`
              : `last free slot lost (${rows} < 100)`)
            if (acceptedTotal !== 1) problems.push(`accepted total ${acceptedTotal}, expected exactly 1`)
            if (newRows !== 1) problems.push(`new fingerprint rows ${newRows}, expected exactly 1`)
            if (seedRows !== 99) problems.push(`existing seed rows ${seedRows}, expected 99`)
            if (total !== 100) problems.push(`repeat counter total ${total}, expected 100`)
            record(tag, problems.length === 0, problems.length === 0
              ? `${detail} — 99 + exactly one accepted = 100, seed intact`
              : `${detail} — ${problems.join('; ')}`)
          } else {
            const duplicates = Number(await sql(`SELECT count(*) FROM client_errors
              WHERE org_id='${ORG}' AND fingerprint='hot_${day}';`))
            const problems = []
            if (duplicates !== 1) problems.push(`rows for fingerprint ${duplicates}, expected 1`)
            if (rows !== 1) problems.push(`rows ${rows}, expected 1`)
            if (total !== 8) problems.push(`count total ${total}, expected 8 (1+3+4)`)
            if (acceptedTotal !== 2) problems.push(`accepted total ${acceptedTotal}, expected 2`)
            record(tag, problems.length === 0, problems.length === 0
              ? `${detail} — increments intact (1+3+4=8), no duplicate row`
              : `${detail} — ${problems.join('; ')}`)
          }
        } finally {
          if (!gate.child.stdin.writableEnded) gate.child.stdin.end(`SELECT pg_advisory_unlock_all();`)
          await gate.done
          await Promise.all(workers.map((w) => w.done.catch(() => {})))
          await sql('DROP TRIGGER IF EXISTS f62_pause ON client_errors;')
        }
      }
    }
  } finally {
    // Own fixture is removed even when a scenario throws.
    await sql(`DROP TRIGGER IF EXISTS f62_pause ON client_errors;
      DROP FUNCTION IF EXISTS f62_pause();
      DELETE FROM client_errors WHERE org_id = '${ORG}';
      DELETE FROM devices WHERE org_id = '${ORG}';
      DELETE FROM locations WHERE org_id = '${ORG}';
      DELETE FROM orgs WHERE id = '${ORG}';
      DELETE FROM auth.users WHERE id = '${USER}';`).catch((failure) => {
      console.log(`WARN cleanup failed: ${failure.message}`)
    })
  }
  const failures = results.filter((result) => !result.ok)
  if (failures.length > 0 || results.length !== 4) {
    throw new Error(`${failures.length} concurrency scenario(s) failed of ${results.length} run`)
  }
  console.log('All telemetry ingest concurrency scenarios passed')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main(process.argv[2])
  } finally {
    for (const child of children) child.kill()
  }
}
