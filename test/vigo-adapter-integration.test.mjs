import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runEngine } from '../scripts/run-benchmark.mjs'

const wrapperSource = process.env.VIGO_BENCH_PYTHON_SOURCE
  ?? fileURLToPath(new URL('../../vigo-py', import.meta.url))
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
  const context = { cityDirectory: root,
    city: { slug: 'fixture', label: 'Fixture', osmPath: '/unused/map.pbf', gtfsPaths: ['/unused/feed.zip'] },
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
