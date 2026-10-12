import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { ENGINE_DEFINITIONS, outputRunDirectory, runEngine, runNdjsonCommand, timingSummary } from '../scripts/run-benchmark.mjs'

const fixture = (body) => [process.execPath, '--input-type=module', '-e', `
  import { createInterface } from 'node:readline';
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    ${body}
  }
`]

test('complete response timing includes large JSON decoding and excludes progress/evidence work', async () => {
  const requests = [{ id: 'a', repeat: 1 }, { id: 'b', repeat: 1 }, { id: 'b-repeat', repeat: 2 }]
  const progress = []
  const result = await runNdjsonCommand(fixture(`
    console.log(JSON.stringify({ id: request.id, status: 'ready', queryMs: 0,
      itinerary: { geometry: 'x'.repeat(1024 * 1024) } }));
  `), requests, { measureRss: false, onProgress: ({ completed }) => {
    const started = performance.now()
    while (performance.now() - started < 25) { /* simulate slow evidence/progress consumer */ }
    progress.push(completed)
  } })
  assert.equal(result.process.code, 0)
  assert.deepEqual(progress, [1, 2, 3])
  for (const row of result.observations) {
    assert(row.wallMs > 0)
    assert(row.requestEncodeMs > 0)
    assert(row.responseDecodeMs > 0)
    assert(row.endToEndMs >= row.wallMs + row.responseDecodeMs)
    assert.equal(row.adapterOverheadMs, row.endToEndMs)
    assert.equal(row.adapterOverheadStatus, 'valid')
    assert(row.responseBytes > 1024 * 1024)
  }
  const summary = timingSummary(result.observations, new Map(requests.map((row) => [row.id, row])))
  assert.equal(summary.processFirst.observations, 1)
  assert.equal(summary.subsequentDistinct.observations, 1)
  assert.equal(summary.first.observations, 2)
  assert.equal(summary.repeated.observations, 1)
  assert(result.process.elapsedMs - summary.endToEnd.sumMs >= 60)
})

test('paired overhead excludes incompatible/missing durations and preserves signed evidence', async () => {
  const requests = [{ id: 'zero' }, { id: 'large' }, { id: 'negative' }, { id: 'missing' }, { id: 'error' }]
  const result = await runNdjsonCommand(fixture(`
    const durations = { zero: 0, large: 1e9, negative: -2 };
    console.log(JSON.stringify({ id: request.id, status: request.id === 'error' ? 'error' : 'blocked', queryMs: durations[request.id] }));
  `), requests, { measureRss: false })
  const [zero, large, negative, missing, error] = result.observations
  assert.equal(zero.adapterOverheadStatus, 'valid')
  assert.equal(large.adapterOverheadStatus, 'adapter_exceeds_end_to_end')
  assert(large.adapterOverheadDeltaMs < 0)
  assert.equal(large.adapterOverheadMs, null)
  assert.equal(negative.adapterOverheadStatus, 'invalid_adapter_timing')
  assert.equal(negative.adapterOverheadMs, null)
  assert.equal(missing.adapterOverheadStatus, 'missing_adapter_timing')
  assert.equal(error.endToEndMs > 0, true)
  const summary = timingSummary(result.observations, new Map())
  assert.equal(summary.endToEnd.samples, 5)
  assert.equal(summary.runnerWall.samples, 4)
  assert.equal(summary.byOutcome.error.endToEnd.samples, 1)
  assert.equal(summary.byOutcome.error.runnerWall.samples, 1)
  assert.equal(summary.byOutcome.ready.endToEnd.meanMs, null)
  assert.equal(summary.adapterOverhead.samples, 1)
  assert.deepEqual(summary.adapterOverhead.validity, { valid: 1, missing_adapter_timing: 2, invalid_adapter_timing: 1, adapter_exceeds_end_to_end: 1, unreported: 0 })
  assert.equal(summary.adapterOverhead.sumMs, zero.endToEndMs)
})

test('malformed JSON and mismatched IDs retain measured error outcomes', async () => {
  const requests = [{ id: 'bad-json' }, { id: 'wrong-id' }, { id: 'valid' }]
  const result = await runNdjsonCommand(fixture(`
    if (request.id === 'bad-json') console.log('not-json');
    else console.log(JSON.stringify({ id: request.id === 'wrong-id' ? 'wrong' : request.id, status: 'ready' }));
  `), requests, { measureRss: false })
  assert.deepEqual(result.observations.map(({ status }) => status), ['error', 'error', 'ready'])
  for (const row of result.observations) assert(row.endToEndMs >= row.wallMs && row.responseDecodeMs > 0)
  assert.match(result.observations[1].error, /does not match/)
})

test('query deadline stops the owned process and leaves unsent requests unobserved', { timeout: 5000 }, async () => {
  const result = await runNdjsonCommand([process.execPath, '-e', 'setInterval(() => {}, 1000)'], [{ id: 'wait' }, { id: 'unsent' }], { measureRss: false, queryTimeoutMs: 100 })
  assert.equal(result.observations.length, 1)
  assert.equal(result.observations[0].status, 'error')
  assert.equal(result.observations[0].timedOut, true)
  assert.equal(result.process.timedOut, true)
  assert.equal(result.observations[0].responseDecodeMs, null)
})

test('shutdown deadline terminates an adapter that responds but does not exit', { timeout: 5000 }, async () => {
  const command = [process.execPath, '-e', `
    process.stdin.on('data', data => console.log(JSON.stringify({ id: JSON.parse(data).id, status: 'ready', queryMs: 0 })));
    setInterval(() => {}, 1000);
  `]
  const result = await runNdjsonCommand(command, [{ id: 'a' }], { measureRss: false, queryTimeoutMs: 250 })
  assert.equal(result.observations[0].status, 'ready')
  assert.equal(result.process.timedOut, true)
  assert.notEqual(result.process.code, 0)
})

test('deadline escalation kills an owned server grandchild after its wrapper has closed', { timeout: 5000, skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-timing-grandchild-'))
  const pidFile = path.join(directory, 'server.pid')
  let pid
  try {
    const server = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    const wrapper = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(server)}], {stdio:'ignore'}); setInterval(() => {}, 1000)`
    const result = await runNdjsonCommand([process.execPath, '-e', wrapper], [{ id: 'wait' }], { measureRss: false, queryTimeoutMs: 350 })
    pid = Number(fs.readFileSync(pidFile, 'utf8'))
    assert.equal(result.process.timedOut, true)
    assert(result.process.elapsedMs >= 700, 'process lifetime must include escalation grace for surviving descendants')
    let alive = true
    for (let attempt = 0; attempt < 30 && alive; attempt += 1) {
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
      if (alive) await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(alive, false, 'owned server grandchild must not survive the query timeout')
  } finally {
    if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* owned fixture already stopped */ }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('SIGTERM aborts a grouped query and cleans up its owned server process', { timeout: 5000, skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-timing-signal-'))
  const pidFile = path.join(directory, 'adapter.pid')
  let runner
  let adapterPid
  try {
    const moduleUrl = new URL('../scripts/run-benchmark.mjs', import.meta.url).href
    const adapter = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000)`
    const source = `import {runNdjsonCommand} from ${JSON.stringify(moduleUrl)};
      try { await runNdjsonCommand([process.execPath,'-e',${JSON.stringify(adapter)}],[{id:'a'},{id:'never'}],{measureRss:false,queryTimeoutMs:0}); process.exitCode=2 }
      catch(error) { console.log(JSON.stringify({code:error.code,signal:error.signal,observations:error.observations.length,sigtermListeners:process.listenerCount('SIGTERM')})); process.exitCode=0 }`
    runner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = once(runner, 'close')
    let stdout = ''
    runner.stdout.on('data', (chunk) => { stdout += chunk })
    const deadline = performance.now() + 2000
    while (!fs.existsSync(pidFile) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    adapterPid = Number(fs.readFileSync(pidFile, 'utf8'))
    runner.kill('SIGTERM')
    const [code] = await closed
    assert.equal(code, 0)
    const outcome = JSON.parse(stdout.trim())
    assert.equal(outcome.code, 'BENCHMARK_INTERRUPTED')
    assert.equal(outcome.signal, 'SIGTERM')
    assert.equal(outcome.observations, 1)
    assert.equal(outcome.sigtermListeners, 0)
    assert.throws(() => process.kill(adapterPid, 0), { code: 'ESRCH' })
  } finally {
    runner?.kill('SIGKILL')
    if (adapterPid) try { process.kill(adapterPid, 'SIGKILL') } catch { /* owned fixture already stopped */ }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('missing metrics stay null and do not masquerade as zero-sample performance', () => {
  const summary = timingSummary([{ id: 'old', status: 'ready', wallMs: 2 }], new Map())
  assert.equal(summary.endToEnd.samples, 0)
  assert.equal(summary.endToEnd.sumMs, null)
  assert.equal(summary.endToEnd.p99Ms, null)
  assert.equal(summary.endToEnd.coverage, 0)
  assert.equal(summary.processFirst.endToEnd.coverage, null)
  assert.equal(summary.adapterOverhead.validity.unreported, 1)
})

test('setup failures persist per-engine summary and terminal progress without inventing query outcomes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-timing-setup-'))
  try {
    const context = { city: { slug: 'fixture', label: 'Fixture', osmPath: '/missing.osm.pbf', gtfsPaths: [] }, cityDirectory: directory, requests: [{ id: 'one' }], od: {} }
    const { row } = await runEngine(context, 'VIGO', { vigoCli: path.join(directory, 'missing.mjs') })
    const saved = JSON.parse(fs.readFileSync(path.join(row.workdir, 'summary.json'), 'utf8'))
    const progress = JSON.parse(fs.readFileSync(path.join(row.workdir, 'progress.json'), 'utf8'))
    assert.equal(saved.status, 'blocked')
    assert.equal(saved.unsubmittedQueries, 1)
    assert.deepEqual(saved.counts, { ready: 0, blocked: 0, errors: 0 })
    assert.equal(progress.total, 1)
    assert.equal(progress.completed, 0)
    assert.equal(progress.phase, 'complete')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('live query progress retains outcome counts and remaining requests before process completion', { timeout: 5000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-timing-live-'))
  const name = 'ProgressFixture'
  ENGINE_DEFINITIONS.set(name, { kind: 'external', inputContract: ['osm', 'gtfs'] })
  let running
  try {
    const adapter = path.join(directory, 'adapter.mjs')
    fs.writeFileSync(adapter, `
      import { createInterface } from 'node:readline';
      if (process.env.VIGO_BENCH_PHASE === 'prepare') console.log(JSON.stringify({network:{street:{nodes:2,edges:1,source:'fixture'},transit:{stops:2,trips:1}}}));
      else for await (const line of createInterface({input:process.stdin})) {
        const request=JSON.parse(line);
        if (request.id === 'second') await new Promise(resolve => setTimeout(resolve,500));
        console.log(JSON.stringify({id:request.id,status:request.id==='first'?'blocked':'ready',queryMs:0}));
      }
    `)
    const context = { city: { slug: 'fixture', label: 'Fixture', osmPath: '/fixture.pbf', gtfsPaths: [] }, cityDirectory: directory,
      contextPath: path.join(directory, 'context.json'), od: { rows: [], odPath: '/fixture.csv' },
      commonNetworkSize: { street: { source: 'input' }, transit: { stops: 2, trips: 1 } }, requests: [{ id: 'first' }, { id: 'second' }] }
    running = runEngine(context, name, { repeats: 1, engineConfig: { engines: { [name]: { command: [process.execPath, adapter], loads: ['osm', 'gtfs'] } } } })
    const progressPath = path.join(directory, 'progressfixture', 'progress.json')
    let live
    const deadline = performance.now() + 3000
    while (performance.now() < deadline) {
      if (fs.existsSync(progressPath)) {
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'))
        if (progress.phase === 'query' && progress.completed === 1) { live = progress; break }
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert(live, 'expected a live partial-query checkpoint')
    assert.deepEqual(live.counts, { ready: 0, blocked: 1, errors: 0 })
    assert.equal(live.submittedQueries, 1)
    assert.equal(live.unsubmittedQueries, 1)
    assert.equal(live.coldPrep.status, 'ready')
    assert(live.coldPrep.ms > 0)
    const { row } = await running
    const final = JSON.parse(fs.readFileSync(progressPath, 'utf8'))
    assert.deepEqual(final.counts, row.counts)
    assert.equal(final.unsubmittedQueries, 0)
  } finally {
    if (running) await running
    ENGINE_DEFINITIONS.delete(name)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('run directory guard preserves frozen evidence and blocked input runs write a manifest', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-timing-manifest-'))
  try {
    fs.writeFileSync(path.join(directory, 'retained.txt'), 'evidence')
    assert.throws(() => outputRunDirectory(directory, directory), /refusing to overwrite retained evidence/)
    const inputRoot = path.join(directory, 'inputs')
    fs.mkdirSync(path.join(inputRoot, 'empty-city'), { recursive: true })
    const runDir = path.join(directory, 'run')
    const result = spawnSync(process.execPath, ['scripts/run-benchmark.mjs', '--input-root', inputRoot, '--engine', 'VIGO', '--run-dir', runDir], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run-manifest.json'), 'utf8'))
    assert.equal(manifest.status, 'complete_with_issues')
    assert.deepEqual(manifest.engines, ['VIGO'])
    assert.deepEqual(manifest.cities, [{ slug: 'empty-city', label: 'Empty City' }])
    assert.equal(manifest.completedEngineCities, 1)
    assert.equal(manifest.controls.queryTimeoutMs, 0)
    assert(fs.existsSync(path.join(runDir, 'empty-city', 'vigo', 'summary.json')))
    const retry = spawnSync(process.execPath, ['scripts/run-benchmark.mjs', '--input-root', inputRoot, '--engine', 'VIGO', '--run-dir', runDir], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' })
    assert.equal(retry.status, 1)
    assert.match(retry.stderr, /refusing to overwrite retained evidence/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})


test('checkpoint throttling preserves first response, phase transitions and final counts', async () => {
  const { createProgressCheckpoint } = await import('../scripts/benchmark-evidence.mjs')
  let clock = 0
  const writes = []
  const checkpoint = createProgressCheckpoint('/unused', { now: () => clock, write: (_, value) => writes.push(structuredClone(value)) })
  const snapshot = { phase: 'query', status: 'running', completed: 0, total: 100 }
  checkpoint(snapshot)
  checkpoint({ ...snapshot, completed: 1 })
  for (let count = 2; count < 99; count++) checkpoint({ ...snapshot, completed: count })
  assert.deepEqual(writes.map(row => row.completed), [0, 1])
  clock = 251
  checkpoint({ ...snapshot, completed: 99 })
  checkpoint({ ...snapshot, completed: 100 })
  checkpoint({ ...snapshot, phase: 'complete', status: 'ready', completed: 100 })
  assert.deepEqual(writes.map(row => row.completed), [0, 1, 99, 100, 100])
})

test('timing distribution supports large populations without argument-stack overflow', async () => {
  const { timingDistribution } = await import('../scripts/benchmark-statistics.mjs')
  const rows = Array.from({ length: 150000 }, (_, i) => ({ status: 'ready', ms: i }))
  const result = timingDistribution(rows, 'ms')
  assert.equal(result.samples, 150000)
  assert.equal(result.minMs, 0)
  assert.equal(result.maxMs, 149999)
  assert.equal(result.p50Ms, 74999)
  assert.equal(result.p99Ms, 148499)
})

test('SIGTERM during preparation records interruption and terminates the owned process', { timeout: 6000, skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-prep-signal-'))
  const pidFile = path.join(directory, 'prepare.pid')
  let runner, adapterPid
  try {
    const moduleUrl = new URL('../scripts/run-benchmark.mjs', import.meta.url).href
    const adapter = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`
    const source = `import {runEngine,ENGINE_DEFINITIONS} from ${JSON.stringify(moduleUrl)};
      ENGINE_DEFINITIONS.set('PrepFixture',{kind:'external',inputContract:['osm','gtfs']});
      const context={city:{slug:'fixture',gtfsPaths:[]},cityDirectory:${JSON.stringify(directory)},requests:[{id:'one'}],od:{}};
      try {await runEngine(context,'PrepFixture',{engineConfig:{engines:{PrepFixture:{loads:['osm','gtfs'],command:[process.execPath,'-e',${JSON.stringify(adapter)}]}}}});process.exitCode=2}
      catch(error){console.log(error.code);process.exitCode=0}`
    runner = spawn(process.execPath, ['--input-type=module','-e',source], { stdio:['ignore','pipe','pipe'] })
    const closed = once(runner,'close')
    let stdout=''
    runner.stdout.on('data',chunk=>{stdout+=chunk})
    const deadline=performance.now()+2500
    while (!fs.existsSync(pidFile) && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10))
    assert(fs.existsSync(pidFile))
    adapterPid=Number(fs.readFileSync(pidFile,'utf8'))
    runner.kill('SIGTERM')
    await closed
    assert.match(stdout,/BENCHMARK_INTERRUPTED/)
    const summary=JSON.parse(fs.readFileSync(path.join(directory,'prepfixture','summary.json')))
    assert.equal(summary.coldPrep.status,'interrupted')
    assert.equal(summary.unsubmittedQueries,1)
    assert.throws(()=>process.kill(adapterPid,0),{code:'ESRCH'})
  } finally {
    runner?.kill('SIGKILL')
    if(adapterPid) try {process.kill(adapterPid,'SIGKILL')} catch {}
    fs.rmSync(directory,{recursive:true,force:true})
  }
})
