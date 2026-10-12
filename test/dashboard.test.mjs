import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { listRuns, loadRun, readObservations, readOdComparison, resolveEvidence } from '../scripts/benchmark-data.mjs'
import { createDashboard, validateLaunch } from '../scripts/benchmark-dashboard.mjs'
import { TIMING_CONTRACT } from '../scripts/run-benchmark.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-dashboard-'))
  const run = path.join(root, 'retained')
  const lane = path.join(run, 'city', 'vigo')
  fs.mkdirSync(lane, { recursive: true })
  const row = { citySlug: 'city', engine: 'VIGO', status: 'ready', workdir: '/stale/moved/run/vigo',
    counts: { ready: 1, blocked: 1, errors: 0 }, hot: { runnerWall: { samples: 2, p50Ms: 3 } } }
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({ cities: [{ citySlug: 'city', city: 'City', engines: [row] }] }))
  fs.writeFileSync(path.join(lane, 'queries.ndjson'), [
    { id: 'one', status: 'ready', queryMs: 2, wallMs: 3, itinerary: { legs: [{ type: 'ride' }] } },
    { id: 'two', status: 'blocked', queryMs: null, wallMs: 4 },
  ].map(JSON.stringify).join('\n') + '\n{"id":')
  return { root, run, lane }
}

test('retained data relocates, preserves missing full latency, and streams partial live evidence', async () => {
  const { root } = fixture()
  try {
    assert.deepEqual(listRuns(root), [])
    const run = loadRun(root, 'retained')
    assert.equal(run.cities[0].engines[0].laneId, 'city/vigo')
    assert.equal(run.cities[0].engines[0].evidenceAvailable, true)
    const compact = await readObservations(root, 'retained', 'city/vigo')
    assert.equal(compact.observations.length, 2)
    assert.equal(compact.observations[0].endToEndMs, null)
    assert.equal(compact.observations[1].queryMs, null)
    assert.equal(compact.observations[0].itinerary, undefined)
    assert.match(compact.warnings[0], /1 incomplete/)
    const full = await readObservations(root, 'retained', 'city/vigo', 'one')
    assert.equal(full.itinerary.legs[0].type, 'ride')
    await assert.rejects(readObservations(root, 'retained', 'city/vigo', 'absent'), /not found/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('catalog excludes legacy summaries and keeps current runs regardless of outcome', () => {
  const { root } = fixture()
  const save = (id, file, data) => {
    const directory = path.join(root, id)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, file), JSON.stringify(data))
  }
  try {
    const city = { citySlug: 'city', engines: [{ engine: 'VIGO' }] }
    const summary = { schemaVersion: 'vigo.coordinate-benchmark.v3', cities: [city] }
    save('legacy-v3', 'summary.json', summary)
    save('legacy-city', 'summary.json', city)
    save('legacy-manifest', 'run-manifest.json', { status: 'complete', cities: [] })
    save('current', 'summary.json', { ...summary, timingContract: TIMING_CONTRACT })
    save('current-city', 'summary.json', { ...city, engines: [{ engine: 'VIGO', timingContract: TIMING_CONTRACT }] })
    for (const status of ['running', 'error', 'interrupted', 'complete_with_issues']) {
      save(status, 'run-manifest.json', { status, cities: [], timingContract: TIMING_CONTRACT })
    }
    assert.deepEqual(listRuns(root).map(run => run.id).sort(), ['complete_with_issues', 'current', 'current-city', 'error', 'interrupted', 'running'])
    assert.equal(fs.existsSync(path.join(root, 'legacy-v3', 'summary.json')), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('evidence paths reject traversal and symlink escapes', () => {
  const { root } = fixture()
  try {
    assert.throws(() => resolveEvidence(root, '../'), /outside/)
    assert.throws(() => resolveEvidence(root, '/etc/passwd'), /relative/)
    fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'))
    assert.throws(() => resolveEvidence(root, 'escape'), /outside/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('metadata symlinks cannot expose data outside the selected results root', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-dashboard-metadata-'))
  const root = path.join(temporary, 'results')
  const run = path.join(root, 'run')
  fs.mkdirSync(run, { recursive: true })
  try {
    const outside = path.join(temporary, 'outside.json')
    fs.writeFileSync(outside, JSON.stringify({ cities: [{ citySlug: 'outside', engines: [{ engine: 'VIGO' }] }] }))
    fs.symlinkSync(outside, path.join(run, 'summary.json'))
    assert.deepEqual(listRuns(root), [])
    assert.throws(() => loadRun(root, 'run'), /No coordinate benchmark data/)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

test('live manifest exposes pending engines and preparation progress without a final summary', () => {
  const { root } = fixture()
  try {
    const run = path.join(root, 'live')
    const lane = path.join(run, 'city', 'otp')
    fs.mkdirSync(lane, { recursive: true })
    fs.writeFileSync(path.join(run, 'run-manifest.json'), JSON.stringify({ timingContract: TIMING_CONTRACT, status: 'running', cities: [{ slug: 'city', label: 'City' }], engines: ['OTP', 'R5'], controls: { repeatsPerPair: 1 } }))
    fs.writeFileSync(path.join(lane, 'progress.json'), JSON.stringify({ phase: 'query', completed: 3, total: 2000, counts: { ready: 1, blocked: 2, errors: 0 } }))
    const data = loadRun(root, 'live')
    assert.equal(data.cities[0].engines.length, 2)
    assert.equal(data.progress[0].phase, 'query')
    assert.equal(data.cities[0].engines[0].unsubmittedQueries, 1997)
    assert.equal(data.cities[0].engines[0].counts.blocked, 2)
    assert.equal(data.cities[0].engines[1].evidenceAvailable, false)
    assert.deepEqual(listRuns(root).map(run => run.id), ['live'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('launch validation accepts only bounded native arguments and valid dates', () => {
  const cities = [{ slug: 'city', inputErrors: [] }]
  const config = { city: 'city', engines: ['VIGO', 'OTP'], serviceDate: '2026-07-14' }
  assert.equal(validateLaunch(config, cities).maxTransfers, 3)
  assert.equal(validateLaunch({ ...config, runKind: 'test' }, cities).runKind, 'test')
  assert.throws(() => validateLaunch({ ...config, runKind: 'invalid' }, cities), /Run type/)
  assert.throws(() => validateLaunch({ ...config, serviceDate: '2026-02-30' }, cities), /date/)
  assert.throws(() => validateLaunch({ ...config, engines: ['$(touch x)'] }, cities), /engines/)
  assert.throws(() => validateLaunch({ ...config, time: '28:80' }, cities), /time/)
  assert.throws(() => validateLaunch({ ...config, maxWalkKm: null }, cities), /maxWalk/)
  assert.throws(() => validateLaunch({ ...config, city: '../elsewhere' }, cities), /city/)
})

test('local HTTP API reads evidence and prevents cross-site run mutations', async () => {
  const { root } = fixture()
  const app = createDashboard({ resultsRoot: root, inputRoot: path.join(root, 'absent') })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const base = `http://127.0.0.1:${app.server.address().port}`
  try {
    const catalog = await (await fetch(`${base}/api/catalog`)).json()
    assert.equal(catalog.engines.length, 9)
    assert.deepEqual(catalog.runs, [])
    const run = await (await fetch(`${base}/api/run?id=retained`)).json()
    assert.equal(run.cities[0].engines[0].engine, 'VIGO')
    assert.equal(run.lanes, undefined)
    const queries = await (await fetch(`${base}/api/queries?run=retained&lane=city/vigo`)).json()
    assert.equal(queries.observations.length, 2)
    assert.equal((await fetch(`${base}/api/run`, { method: 'POST', body: '{}' })).status, 403)
    assert.equal((await fetch(`${base}/api/run`, { method: 'POST', headers: { 'X-Benchmark-Token': catalog.token, Origin: 'https://example.com' }, body: '{}' })).status, 403)
    assert.equal((await fetch(`${base}/api/run?id=..%2F`)).status, 400)
    assert.equal((await fetch(`${base}/api/run`, { method: 'POST', headers: { 'X-Benchmark-Token': catalog.token }, body: '{}' })).status, 400)
    const logDirectory = path.join(root, '.dashboard-logs')
    fs.mkdirSync(logDirectory)
    fs.writeFileSync(path.join(logDirectory, 'retained.json'), JSON.stringify({ id: 'retained', status: 'running' }))
    const untracked = await (await fetch(`${base}/api/run?id=retained`)).json()
    assert.equal(untracked.activeRun.status, 'untracked')
    assert.equal(untracked.status, 'untracked')
    fs.writeFileSync(path.join(logDirectory, 'retained.json'), JSON.stringify({ id: 'retained', status: 'interrupted', completedAt: '2026-09-22T00:00:00Z' }))
    const interrupted = await (await fetch(`${base}/api/run?id=retained`)).json()
    assert.equal(interrupted.status, 'interrupted')
    assert.equal(interrupted.completedAt, '2026-09-22T00:00:00Z')
  } finally { await new Promise(resolve => app.server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) }
})

test('dashboard launches one fresh process, retains completion, and refuses a concurrent run', { timeout: 15000 }, async () => {
  const { root } = fixture()
  const input = path.join(root, 'inputs', 'city')
  fs.mkdirSync(input, { recursive: true })
  fs.writeFileSync(path.join(input, 'map.pbf'), '')
  fs.writeFileSync(path.join(input, 'feed.zip'), '')
  const runner = path.join(root, 'fixture-runner.mjs')
  fs.writeFileSync(runner, `import fs from 'node:fs';import path from 'node:path';
    const dir=process.argv[process.argv.indexOf('--run-dir')+1];fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'run-manifest.json'),JSON.stringify({status:'complete_with_issues',cities:[],engines:[]}));
    console.log('controlled launcher fixture, no routing'); console.log(JSON.stringify(process.argv.slice(2))); setTimeout(() => {}, 400);`)
  const app = createDashboard({ resultsRoot: root, inputRoot: path.dirname(input), runner })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const base = `http://127.0.0.1:${app.server.address().port}`
  try {
    const { token } = await (await fetch(`${base}/api/catalog`)).json()
    const options = { method: 'POST', headers: { 'X-Benchmark-Token': token }, body: JSON.stringify({ city: 'city', engines: ['VIGO'], nearStopCount: 1000 }) }
    const concurrent = await Promise.all([fetch(`${base}/api/run`, options), fetch(`${base}/api/run`, options)])
    assert.deepEqual(concurrent.map(response => response.status).sort(), [202, 409])
    const launched = await concurrent.find(response => response.status === 202).json()
    assert.equal(launched.status, 'running')
    assert.equal((await fetch(`${base}/api/run`, options)).status, 409)
    await app.waitForIdle()
    assert.equal(app.activeRun.status, 'complete_with_issues')
    const log = await (await fetch(`${base}/api/log?run=${launched.id}`)).json()
    assert.match(log.text, /controlled launcher fixture/)
    assert.match(log.text, /"--near-stop-count","1000"/)
    assert.match(log.text, /"--station-pivot-count","1000"/)
    assert.match(log.text, /"--near-stop-max-m","400"/)
    const testConfig = { city: 'city', engines: ['VIGO'], runKind: 'test', randomCount: 4, nearStopCount: 3, stationPivotCount: 3 }
    const response = await fetch(`${base}/api/run`, { ...options, body: JSON.stringify(testConfig) })
    assert.equal(response.status, 202)
    const added = await response.json()
    assert.match(added.id, /^test-/)
    assert.notEqual(added.id, launched.id)
    await app.waitForIdle()
    const testLog = await (await fetch(`${base}/api/log?run=${added.id}`)).json()
    assert.match(testLog.text, /"--random-count","4"/)
    assert.match(testLog.text, /"--near-stop-count","3"/)
    assert.match(testLog.text, /"--station-pivot-count","3"/)
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.dashboard-logs', `${added.id}.json`)))
    assert.equal(saved.config.runKind, 'test')
    assert.equal(fs.existsSync(path.join(root, launched.id, 'run-manifest.json')), true)
    const sourceSummary = JSON.parse(fs.readFileSync(path.join(root, 'retained', 'summary.json')))
    sourceSummary.completedAt = '2026-09-26T00:00:00Z'
    fs.writeFileSync(path.join(root, 'retained', 'summary.json'), JSON.stringify(sourceSummary))
    fs.writeFileSync(path.join(root, 'retained', 'city', 'od.csv'), 'id,origin_lon,origin_lat,destination_lon,destination_lat\none,1,2,3,4\n')
    const replayResponse = await fetch(`${base}/api/run`, { ...options, body: JSON.stringify({ ...testConfig, reuseRun: 'retained', engines: ['OTP', 'MOTIS'] }) })
    assert.equal(replayResponse.status, 202)
    const replay = await replayResponse.json()
    await app.waitForIdle()
    const replayLog = await (await fetch(`${base}/api/log?run=${replay.id}`)).json()
    const args = JSON.parse(replayLog.text.split('\n').find(line => line.startsWith('[')))
    const replayDirectory = args[args.indexOf('--reuse-run') + 1]
    assert.ok(replayDirectory.startsWith(path.join(fs.realpathSync(root), '.benchmarks')))
    assert.deepEqual(fs.readFileSync(path.join(replayDirectory, 'city', 'od.csv')), fs.readFileSync(path.join(root, 'retained', 'city', 'od.csv')))
    assert.equal(args[args.indexOf('--engines') + 1], 'OTP,MOTIS')
    for (const flag of ['--random-count', '--time', '--repeats', '--cache-mode', '--max-walk']) assert.equal(args.includes(flag), false, `Reuse must inherit ${flag}`)
    assert.equal((await fetch(`${base}/api/run`, { ...options, body: JSON.stringify({ ...testConfig, reuseRun: '../elsewhere' }) })).status, 400)
  } finally { app.terminate(); await app.waitForIdle(); await new Promise(resolve => app.server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) }
})


test('dashboard accepts custom populations and rejects invalid ranges and empty workloads', () => {
  const cities = [{ slug: 'test', inputErrors: [] }]
  const config = { city: 'test', engines: ['VIGO'], nearStopCount: 1000 }
  const valid = validateLaunch(config, cities)
  assert.equal(valid.randomCount + valid.nearStopCount + valid.stationPivotCount, 3000)
  assert.equal(valid.nearStopMaxMeters, 400)
  assert.throws(() => validateLaunch({ ...config, nearStopCount: 1.5 }, cities), /integer/)
  assert.throws(() => validateLaunch({ ...config, nearStopMinMeters: 500 }, cities), /offset range/)
  assert.throws(() => validateLaunch({ ...config, randomCount: 0, nearStopCount: 0, stationPivotCount: 0 }, cities), /positive/)
})


test('OD explorer retains unsubmitted corpus rows and detects cross-engine coordinate mismatches', async () => {
  const { root, run, lane } = fixture()
  try {
    fs.writeFileSync(path.join(run, 'city', 'od.csv'), 'id,origin_lon,origin_lat,destination_lon,destination_lat,od_type\nfirst,1,2,3,4,random\nsecond,5,6,7,8,near_stop\n')
    fs.writeFileSync(path.join(lane, 'queries.ndjson'), JSON.stringify({id:'first_run_1',odId:'first',repeat:1,status:'blocked',origin:{coordinate:[1,2]},destination:{coordinate:[3,4]}})+'\n')
    const other = path.join(run, 'city', 'otp');fs.mkdirSync(other)
    const summary = JSON.parse(fs.readFileSync(path.join(run,'summary.json')))
    summary.cities[0].engines.push({engine:'OTP',status:'ready'})
    fs.writeFileSync(path.join(run,'summary.json'),JSON.stringify(summary))
    fs.writeFileSync(path.join(other,'queries.ndjson'), JSON.stringify({id:'first_run_1',odId:'first',status:'ready',origin:{coordinate:[9,9]},destination:{coordinate:[3,4]}})+'\n')
    const result = await readOdComparison(root, 'retained', 'city')
    assert.equal(result.requests.length, 2)
    assert.equal(result.requests[0].engines.VIGO.status, 'blocked')
    assert.equal(result.requests[0].engines.OTP.status, 'mismatch')
    assert.deepEqual(result.requests[1].engines, {})
    assert.equal(result.requests[1].odType, 'near_stop')
    await assert.rejects(readOdComparison(root, 'retained', '../elsewhere'), /city/)
  } finally { fs.rmSync(root,{recursive:true,force:true}) }
})
