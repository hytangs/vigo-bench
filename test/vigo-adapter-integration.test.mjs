import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { resolveVigoPythonSource } from '../scripts/vigo-runtime.mjs'
import { fingerprint } from '../scripts/benchmark-recording.mjs'
import { runEngine } from '../scripts/run-benchmark.mjs'

const wrapperSource = resolveVigoPythonSource(fileURLToPath(new URL('..', import.meta.url)))
const python = process.env.PYTHON ?? 'python3'

function fixture(t, productVersion = '0.5.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-adapter-fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  // No native preparation or routing: the child only records requests and emits fixtures.
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 10n * 1024n ** 3n, bsize: 1n }))
  const cli = path.join(root, 'fixture.mjs'), calls = path.join(root, 'calls.ndjson')
  fs.writeFileSync(cli, `
    import fs from 'node:fs';
    import path from 'node:path';
    import { createInterface } from 'node:readline';
    const args = process.argv.slice(2), command = args[0];
    const option = name => args.find(value => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
    const record = value => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(value) + '\\n');
    record({command, args});
    if (command === 'capabilities') {
      console.log(JSON.stringify({schemaVersion:'vigo.capabilities.v3',productVersion:'0.5.0',
        apiVersion:'1.0',cityFormatVersion:1,resultSchemaVersion:1,
        publicCliCommands:['build','build-scenarios','capabilities','inspect','route','matrix','reach','stream','compare'],
        output:{diagnostics:['none','trace']},queries:[{id:'route',maxTransfers:true,transitStreetCacheControl:true}]}));
    } else if (command === 'build') {
      const output = option('output');
      const manifest = {schemaVersion:'vigo.city.v1',cityFormatVersion:1,productVersion:${JSON.stringify(productVersion)},
        modes:['transit','walk'],streetStore:{nodeCount:2,edgeCount:2},routingStore:{stopCount:2,tripCount:1,routeCount:1,connectionCount:1}};
      for (const file of ['routing/project.sqlite','osm/street-index.sqlite']) {
        fs.mkdirSync(path.dirname(path.join(output,file)),{recursive:true});
        fs.writeFileSync(path.join(output,file),'fixture');
      }
      fs.writeFileSync(path.join(output,'network.json'),JSON.stringify(manifest));
      console.log(JSON.stringify(manifest));
    } else if (command === 'stream') {
      if (!args.includes('--diagnostics=trace')) throw Error('Detailed evidence must be requested');
      for await (const line of createInterface({input:process.stdin})) {
        const q = JSON.parse(line);
        record({request:q,serviceDate:q.serviceDate ?? option('service-date')});
        if (q.kind !== 'route' || 'odId' in q || 'repeat' in q || 'maxJourneyDurationMinutes' in q) throw Error('Invalid wire request');
        const blocked = q.destination.coordinate[1] === 42.2;
        const plan = blocked ? {status:'blocked',diagnostics:{failureCode:'no_path'}}
          : {status:'ready',travelMode:'transit',durationMinutes:2,departMinutes:553,arriveMinutes:555,transfers:0,
            legs:[{type:'ride',startMinutes:553,endMinutes:555,durationMinutes:2,tripId:'feed\\u001fT',
              fromStopId:'feed\\u001fA',toStopId:'feed\\u001fB',coordinates:[[-71,42],[-71.1,42.1]]}]};
        console.log(JSON.stringify({id:q.id,schema:'vigo.route.v1',status:blocked?'not_found':'ok',
          meta:{requestId:q.id,engineVersion:'0.5.0'},trace:{kind:'route',status:plan.status,
            resultSchemaVersion:1,productVersion:'0.5.0',result:plan,timing:{computeMs:1.25,openMs:40}}}));
      }
    } else throw Error('Unexpected command: ' + command);
  `)
  // The simulated runtime never reads inputs, but VIGO-py rejects missing files before building.
  const osmPath = path.join(root, 'map.pbf'), gtfsPath = path.join(root, 'feed.zip')
  for (const file of [osmPath, gtfsPath]) fs.writeFileSync(file, 'fixture')
  const context = { cityDirectory: root,
    city: { slug: 'fixture', label: 'Fixture', osmPath, gtfsPaths: [gtfsPath] },
    contextPath: path.join(root, 'context.json'), routingPreference: 'fastest',
    serviceDate: '2026-10-08', time: '08:00', maxWalkKm: 1.2,
    comparison: { requireTransitRide: true, maxTransfers: 3, horizonMinutes: 240 },
    commonNetworkSize: { street: { nodes: null, edges: null, source: 'fixture' }, transit: { stops: 2, trips: 1 } },
    od: { odPath: '/unused/od.csv', rows: [{ id: 'a' }, { id: 'b' }] },
    requests: [
      { id: 'q1', odId: 'a', repeat: 1, origin: { coordinate: [-71, 42] }, destination: { coordinate: [-71.1, 42.1] },
        time: '09:13', serviceDate: '2026-10-09', maxTransfers: 0, maxWalkKm: .4, horizonMinutes: 37,
        disableCache: true, maxJourneyDurationMinutes: 37 },
      { id: 'q2', odId: 'b', repeat: 1, origin: { coordinate: [-71, 42] }, destination: { coordinate: [-71.1, 42.2] },
        timePreference: 'arrive_by', time: '22:05', serviceDate: '2026-10-10' },
    ] }
  fs.writeFileSync(context.contextPath, JSON.stringify(context))
  return { context, calls, options: { python, vigoCli: cli, vigoPythonSource: wrapperSource, repeats: 1, queryTimeoutMs: 10_000 } }
}

for (const engine of ['VIGO', 'VIGO-py']) {
  test(`${engine} adapter passes current requests and retains detailed results through a simulated runtime`, async t => {
    if (engine === 'VIGO-py' && (!fs.existsSync(path.join(wrapperSource, 'vigo', '__init__.py'))
      || spawnSync(python, ['--version']).status !== 0)) {
      t.skip('VIGO-py source and Python are required for the optional wrapper integration check')
      return
    }
    const { context, calls, options } = fixture(t)
    const { row, observations } = await runEngine(context, engine, options)
    assert.equal(row.status, 'ready', JSON.stringify(row.errors))
    assert.equal(row.setupErrors, 0)
    assert.deepEqual(row.counts, { ready: 1, blocked: 1, errors: 0 })
    assert.equal(observations[0].itinerary.legs[0].tripId, 'feed\u001fT')
    assert.deepEqual(observations[0].itinerary.legs[0].coordinates, [[-71, 42], [-71.1, 42.1]])
    assert.equal(observations[0].timing.computeMs, 1.25)
    assert.equal(observations[0].timing.openMs, 40)
    assert.equal(observations[1].failure, 'no_path')
    if (engine === 'VIGO-py') {
      assert.equal(observations[0].queryMs, observations[0].timing.pythonApiAndSerializationMs)
      assert.deepEqual(row.preparation.pythonRuntime.command, [process.execPath, options.vigoCli])
    } else assert.equal(observations[0].queryMs, 1.25)
    const requests = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(value => value.request)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].serviceDate, '2026-10-09')
    assert.equal(requests[0].request.time, '09:13')
    assert.equal(requests[0].request.maxTransfers, 0)
    assert.equal(requests[0].request.maxWalkKm, .4)
    assert.equal(requests[0].request.horizonMinutes, 37)
    assert.equal(requests[0].request.disableCache, true)
    assert.equal(requests[1].serviceDate, '2026-10-10')
    assert.equal(requests[1].request.time, '22:05')
    assert(['arrive', 'arrive_by'].includes(requests[1].request.timePreference))
  })
}

test('an incompatible prepared City is a setup failure without submitted queries', async t => {
  const { context, calls, options } = fixture(t, '0.4.4')
  const { row, observations } = await runEngine(context, 'VIGO', options)
  assert.equal(row.status, 'error')
  assert.equal(row.setupErrors, 1)
  assert.equal(row.unsubmittedQueries, 2)
  assert.deepEqual(row.counts, { ready: 0, blocked: 0, errors: 0 })
  assert.equal(observations.length, 0)
  assert.match(row.errors.join(' '), /current City/)
  assert(!fs.readFileSync(calls, 'utf8').includes('"command":"stream"'))
})


test('verified City reuse preserves queries and excludes preparation timing; changed inputs fail', async t => {
  const { context, calls, options } = fixture(t)
  const previous = path.join(context.cityDirectory, 'previous')
  const first = { ...context, cityDirectory: path.join(previous, 'fixture') }
  fs.mkdirSync(first.cityDirectory, { recursive: true })
  await runEngine(first, 'VIGO', options)
  const identity = { inputs: { digest: 'a'.repeat(64) } }
  fs.writeFileSync(path.join(first.cityDirectory, 'recording.json'), JSON.stringify(identity))
  fs.writeFileSync(path.join(context.cityDirectory, 'recording.json'), JSON.stringify(identity))
  fs.mkdirSync(path.join(previous, 'provenance'))
  const runtime = await fingerprint(options.vigoCli)
  fs.writeFileSync(path.join(previous, 'provenance/manifest.json'), JSON.stringify({ node: process.version, runtimes: { vigoCli: runtime, vigoKernel: runtime, vigoNode: await fingerprint(process.execPath) } }))
  const reuse = { ...options, vigoKernel: options.vigoCli, reuseVigoBuilds: previous }
  const { row, observations } = await runEngine(context, 'VIGO', reuse)
  assert.equal(row.round.complete, true)
  assert.equal(observations.length, 2)
  assert.equal(row.executionContract.preparedNetworkReused, true)
  assert.equal(row.coldPrep.ms, null)
  assert.equal(row.round.preparationAndQueryMs, null)
  assert.equal(row.round.amortizedPreparationAndQueryMsPerRequest, null)
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.command === 'build').length, 1)
  const sourceManifest = fs.readFileSync(path.join(first.cityDirectory, 'vigo/network/network.json'), 'utf8')
  fs.writeFileSync(path.join(context.cityDirectory, 'vigo/network/network.json'), '{}')
  assert.equal(fs.readFileSync(path.join(first.cityDirectory, 'vigo/network/network.json'), 'utf8'), sourceManifest)
  fs.writeFileSync(path.join(context.cityDirectory, 'recording.json'), JSON.stringify({ inputs: { digest: 'changed' } }))
  const mismatch = await runEngine(context, 'VIGO', reuse)
  assert.equal(mismatch.row.setupErrors, 1)
  assert.equal(mismatch.row.unsubmittedQueries, 2)
  assert.equal(mismatch.observations.length, 0)
  assert.match(mismatch.row.errors.join(' '), /input identity mismatch/)
  const corrupt = JSON.parse(fs.readFileSync(path.join(previous, 'provenance/manifest.json'), 'utf8'))
  corrupt.runtimes.vigoKernel.sha256 = 'b'.repeat(64)
  fs.writeFileSync(path.join(previous, 'provenance/manifest.json'), JSON.stringify(corrupt))
  const runtimeMismatch = await runEngine(context, 'VIGO', reuse)
  assert.equal(runtimeMismatch.row.setupErrors, 1)
  assert.match(runtimeMismatch.row.errors.join(' '), /runtime mismatch/)
})


test('runtime-change reuse is explicit and records both readers without accepting missing provenance', async t => {
  const { context, options } = fixture(t, '1.0.0-rc.2')
  const previous = path.join(context.cityDirectory, 'previous')
  const first = { ...context, cityDirectory: path.join(previous, 'fixture') }
  fs.mkdirSync(first.cityDirectory, { recursive: true })
  const built = await runEngine(first, 'VIGO', options)
  assert.equal(built.row.status, 'ready')
  const identity = { inputs: { digest: 'a'.repeat(64) } }
  fs.writeFileSync(path.join(first.cityDirectory, 'recording.json'), JSON.stringify(identity))
  fs.writeFileSync(path.join(context.cityDirectory, 'recording.json'), JSON.stringify(identity))
  const reuse = { ...options, vigoKernel: options.vigoCli, reuseVigoBuilds: previous, allowReusedRuntimeChange: true }
  const absent = await runEngine(context, 'VIGO', reuse)
  assert.equal(absent.row.setupErrors, 1)
  assert.equal(absent.observations.length, 0)
  assert.match(absent.row.errors.join(' '), /missing its provenance/)
  fs.mkdirSync(path.join(previous, 'provenance'))
  const runtime = await fingerprint(options.vigoCli)
  const manifest = { node: process.version, runtimes: { vigoCli: runtime, vigoKernel: { ...runtime, sha256: 'b'.repeat(64) }, vigoNode: await fingerprint(process.execPath) } }
  fs.writeFileSync(path.join(previous, 'provenance/manifest.json'), JSON.stringify(manifest))
  const result = await runEngine(context, 'VIGO', reuse)
  assert.equal(result.row.status, 'ready', result.row.errors.join(' '))
  assert.equal(result.row.coldPrep.status, 'reused')
  assert.equal(result.row.requiredInputs.preparationLog, 'reused-preparation.json')
  const recorded = JSON.parse(fs.readFileSync(path.join(context.cityDirectory, 'vigo/reused-preparation.json')))
  assert.equal(recorded.readerChanges.vigoKernel.preparedWith.sha256, 'b'.repeat(64))
  assert.equal(recorded.readerChanges.vigoKernel.queriedWith.sha256, runtime.sha256)
  delete manifest.runtimes.vigoKernel.sha256
  fs.writeFileSync(path.join(previous, 'provenance/manifest.json'), JSON.stringify(manifest))
  const missingHash = await runEngine(context, 'VIGO', reuse)
  assert.equal(missingHash.row.setupErrors, 1)
  assert.match(missingHash.row.errors.join(' '), /Missing reused City runtime fingerprint/)
})
