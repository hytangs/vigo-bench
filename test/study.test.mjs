import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { defaultStudy, validateStudy, studyArguments, studyIdentity, runtimeArguments } from '../scripts/benchmark-study.mjs'
import { fairnessRecord, pairedComparison } from '../scripts/benchmark-fairness.mjs'
import { timingDistribution } from '../scripts/benchmark-statistics.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
test('named workflows forward explicit VIGO runtime selection without changing study controls', () => {
  const selected = new Map([['vigo-cli', ['/selected/vigo.mjs']], ['vigo-kernel', ['/selected/kernel.node']],
    ['vigo-python-source', ['/selected/wrapper']], ['engines', ['VIGO,VIGO-py']]])
  assert.deepEqual(runtimeArguments(selected), ['--vigo-cli', '/selected/vigo.mjs', '--vigo-kernel', '/selected/kernel.node',
    '--vigo-python-source', '/selected/wrapper'])
  assert.throws(() => runtimeArguments(new Map([['vigo-kernal', ['typo']]])), /Unknown workflow flag/)
})
test('study configuration preserves common settings and rejects silent typos', () => {
  const config = validateStudy({ ...defaultStudy(), maxTransfers: 5, horizonMinutes: 360 })
  const args = studyArguments(config, { inputRoot: '/inputs', city: 'new_city', reuse: '/saved' })
  assert.equal(args[args.indexOf('--max-transfers') + 1], '5')
  assert.equal(args[args.indexOf('--horizon') + 1], '360')
  assert.equal(args[args.indexOf('--cache-mode') + 1], 'native')
  assert(!args.includes('--near-stop-count'))
  assert.equal(studyIdentity(config), studyIdentity({ ...config, engines: ['MOTIS'] }))
  assert.notEqual(studyIdentity(config), studyIdentity({ ...config, time: '09:00' }))
  assert.throws(() => validateStudy({ ...config, horzion: 99 }), /Unknown/)
  assert.throws(() => validateStudy({ ...config, time: '25:00' }), /HH:MM/)
  assert.throws(() => validateStudy({ ...config, engines: ['VIGO', 'VIGO'] }), /unique/)
})
test('fairness records cannot claim uniform cache disabling or equivalent native work', () => {
  const record = fairnessRecord(['VIGO', 'MOTIS'], 'disabled')
  assert.equal(record.strictNativeEquivalence, false)
  assert.match(record.cacheWarning, /not uniformly supported/)
  assert.equal(record.primaryMetric, 'endToEndMs')
  assert.match(record.engines.VIGO.extraWork, /fare/)
  const lane = (engine, rows, complete = true) => ({ engine, rows: new Map(rows.map(row => [row.id, row])), counts: {}, complete })
  const a = lane('A', [{ id: 'same', status: 'ready', endToEndMs: 5 }, { id: 'different', status: 'ready', endToEndMs: 1 }])
  const b = lane('B', [{ id: 'same', status: 'ready', endToEndMs: 7 }, { id: 'different', status: 'blocked', endToEndMs: .1 }])
  const paired = pairedComparison([a,b], timingDistribution)
  assert.deepEqual(paired.commonReadyIds, ['same'])
  assert.equal(paired.engines.A.fullQuery.p50Ms, 5)
  b.complete = false
  assert.equal(pairedComparison([a,b], timingDistribution).commonReadyCount, 0)
})

test('new-city generation, replay recording, inherited controls and tamper rejection', { timeout: 30000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-study-'))
  const input = path.join(root, 'input'), city = path.join(input, 'new_city')
  const run = (args, status = 0) => {
    const result = spawnSync(process.execPath, ['scripts/run-benchmark.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, status, result.stderr)
    return result
  }
  try {
    fs.mkdirSync(city, { recursive: true })
    const init = spawnSync(process.execPath, ['scripts/benchmark-study.mjs', 'init', 'new_city', '--input-root', input], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    assert.equal(JSON.parse(fs.readFileSync(path.join(city,'benchmark.json'))).population.nearStop, 1000)
    const again = spawnSync(process.execPath, ['scripts/benchmark-study.mjs', 'init', 'new_city', '--input-root', input], { cwd: ROOT })
    assert.equal(again.status, 1)
    fs.writeFileSync(path.join(city,'map.pbf'), 'synthetic fixture; no native OSM routing')
    const tables = {
      'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\na,A,https://example.com,UTC\n',
      'stops.txt': 'stop_id,stop_name,stop_lon,stop_lat\na,A,-77,39\nb,B,-76,40\nc,C,-75,41\n',
      'routes.txt': 'route_id,agency_id,route_type\nr,a,3\n',
      'trips.txt': 'route_id,service_id,trip_id\nr,s,t\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt,08:00:00,08:00:00,a,1\nt,08:10:00,08:10:00,b,2\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns,1,1,1,1,1,1,1,20260901,20260930\n',
    }
    const zipped = spawnSync('python3', ['-c', "import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); [z.writestr(k,v) for k,v in json.load(sys.stdin).items()]; z.close()", path.join(city,'feed.zip')], { input: JSON.stringify(tables), encoding: 'utf8' })
    assert.equal(zipped.status, 0, zipped.stderr)
    const workload = path.join(root,'workload')
    run(['--input-root',input,'--cities','new_city','--generate-only','--random-count','0','--near-stop-count','2','--station-pivot-count','0','--max-transfers','5','--horizon','360','--run-dir',workload])
    const source = JSON.parse(fs.readFileSync(path.join(workload,'summary.json')))
    assert.equal(source.runMode, 'workload-only')
    assert.equal(source.cities[0].status, 'workload-ready')
    assert.deepEqual(source.engines, [])
    const adapter = path.join(root,'adapter.mjs')
    fs.writeFileSync(adapter, `import {createInterface} from 'node:readline'; if(process.env.VIGO_BENCH_PHASE==='prepare') console.log(JSON.stringify({network:{street:{nodes:2,edges:1,source:'fixture'},transit:{stops:3,trips:1}}})); else for await(const line of createInterface({input:process.stdin})){const q=JSON.parse(line);console.log(JSON.stringify({id:q.id,status:'ready',queryMs:0,itinerary:{legs:[]}}));}`)
    const engineConfig = path.join(root,'engines.json')
    fs.writeFileSync(engineConfig,JSON.stringify({engines:{Fixture:{loads:['osm','gtfs'],command:[process.execPath,adapter]}}}))
    const replay = path.join(root,'replay')
    const args = ['--input-root',input,'--cities','new_city','--reuse-run',workload,'--engine','Fixture','--engine-config',engineConfig]
    run([...args,'--run-dir',replay])
    const saved = JSON.parse(fs.readFileSync(path.join(replay,'summary.json')))
    assert.equal(saved.controls.comparison.maxTransfers,5)
    assert.equal(saved.controls.comparison.horizonMinutes,360)
    assert.equal(saved.cities[0].recording.comparisonId,source.cities[0].recording.comparisonId)
    assert(fs.existsSync(path.join(replay,'provenance','scripts','benchmark-study.mjs')))
    assert.equal(JSON.parse(fs.readFileSync(path.join(replay,'fairness.json'))).primaryMetric,'endToEndMs')
    assert.equal(fs.readFileSync(path.join(replay,'new_city','fixture','queries.ndjson'),'utf8').trim().split('\n').length,2)
    fs.appendFileSync(path.join(city,'map.pbf'),'changed')
    assert.match(run([...args,'--run-dir',path.join(root,'changed')],1).stderr,/Input contents changed/)
    fs.writeFileSync(path.join(city,'map.pbf'),'synthetic fixture; no native OSM routing')
    fs.appendFileSync(path.join(workload,'new_city','od.csv'),'\n')
    assert.match(run([...args,'--run-dir',path.join(root,'changed-od')],1).stderr,/Saved OD CSV changed/)
  } finally { fs.rmSync(root,{recursive:true,force:true}) }
})
