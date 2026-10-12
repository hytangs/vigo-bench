import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  generateWorkload,
  workloadConfig,
  appendWorkload,
  validateOdPopulation,
  DEFAULT_ENGINES,
  ENGINE_DEFINITIONS,
  allocateOdCounts,
  buildServiceModel,
  buildStationPivotRows,
  destinationPoint,
  discoverCities,
  extractGtfsStops,
  haversineDistanceMeters,
  inferServiceDate,
  inferServiceDay,
  loadReuseRun,
  normalizeObservation,
  parseArguments,
  parseCsv,
  parseOdMix,
  parseOdRows,
  percentile,
  prepareCommand,
  queryCommand,
  queryRequests,
  reusedPairCount,
  reuseOdFile,
  runEngine,
  selectedEngines,
  serializeOdRows,
  summarizeByOdType,
  timingSummary,
} from '../scripts/run-benchmark.mjs'

test('formal engine set contains nine retained engines and rejects retired adapters', () => {
  assert.equal(DEFAULT_ENGINES.length, 9)
  assert(DEFAULT_ENGINES.includes('VIGO-py'))
  for (const engine of ['Bifrost', 'Ferrobus', 'TransitTime']) {
    assert.throws(() => selectedEngines(parseArguments(['--engine', engine])), /Unknown engine/)
  }
})

test('full Python result and missing numerical fields survive protocol normalization', () => {
  const route = { status: 'ready', legs: [{ type: 'ride', coordinates: [[0, 0], [1, 1]] }] }
  const result = normalizeObservation({ id: 'a' }, { result: { kind: 'route', result: route }, queryMs: null }, 2)
  assert.deepEqual(result.itinerary, route)
  assert.equal(result.route.durationMinutes, null)
  assert.equal(result.queryMs, null)
  assert.equal(result.engineQueryMs, null)
})

test('policy-rejected native candidates survive evidence normalization', () => {
  const rejectedItinerary = { legs: [{ type: 'walk' }] }
  const plan = { status: 'blocked', diagnostics: { outcomeReason: 'native_candidate_rejected', policyViolations: ['transit_required'] } }
  const result = normalizeObservation({ id: 'a' }, { status: 'blocked', plan, rejectedItinerary }, 2)
  assert.equal(result.status, 'blocked')
  assert.deepEqual(result.rejectedItinerary, rejectedItinerary)
  assert.deepEqual(result.itinerary.diagnostics, plan.diagnostics)
})

test('current VIGO adapter builds a City and queries the resident stream with earliest arrival', () => {
  const context = { city: { slug: 'test', osmPath: '/input/map.pbf', gtfsPaths: ['/input/a.zip', '/input/b.zip'] },
    workdir: '/run/vigo', contextPath: '/run/context.json', od: { odPath: '/run/od.csv' },
    routingPreference: 'fastest', time: '08:00', serviceDate: '2026-07-15', serviceDay: 'weekday', maxWalkKm: 1.2 }
  const options = { vigoCli: '/engine/public/vigo.mjs' }
  const build = prepareCommand('VIGO', context, options)
  assert.deepEqual(build.command, [process.execPath, options.vigoCli, 'build', '--street-modes=walk', '--osm=/input/map.pbf',
    '--output=/run/vigo/network', '--gtfs=/input/a.zip', '--gtfs=/input/b.zip'])
  assert.match(prepareCommand('VIGO', { ...context, routingPreference: 'balanced' }, options).reason, /earliest_arrival/)
  assert.match(queryCommand('VIGO', context, options, { schemaVersion: 'vigo.cli.build-network.v1' }).reason, /current City/)
  const manifest = { schemaVersion: 'vigo.city.v1', productVersion: '0.5.0' }
  const query = queryCommand('VIGO', context, options, manifest)
  assert(query.command.includes('stream'))
  assert(query.command.includes('--diagnostics=trace'))
  const detailed = queryCommand('VIGO', context, { ...options, vigoCapabilities: { output: { streamFormats: ['public', 'detailed'] } } }, manifest)
  assert(detailed.command.includes('--stream-output=detailed'))
  assert(!detailed.command.includes('--diagnostics=trace'))
  assert(query.command.includes('--city=/run/vigo/network'))
  assert(!query.command.some((value) => value.startsWith('--routing-preference=')))
  assert(!query.command.some(value => value.startsWith('--time=') || value.startsWith('--service-date=')), 'Per-request clocks must not be overridden by stream flags')
  assert.match(prepareCommand('VIGO-py', { ...context, routingPreference: 'balanced' }, options).reason, /earliest_arrival/)
  for (const engine of ['VIGO', 'VIGO-py']) {
    assert.match(queryCommand(engine, context, options, { ...manifest, productVersion: '0.4.4' }).reason, /Engine 0.5/)
    const selected = queryCommand(engine, context, { ...options, vigoKernel: '/selected/kernel.node', vigoPythonSource: '/selected/wrapper' }, manifest)
    assert.deepEqual(JSON.parse(selected.env.VIGO_BENCH_VIGO_COMMAND_JSON), [process.execPath, options.vigoCli])
    assert.equal(selected.env.VIGO_NATIVE_ROUTING_KERNEL, '/selected/kernel.node')
    assert.equal(selected.env.VIGO_BENCH_PYTHON_SOURCE, '/selected/wrapper')
  }
})

test('current stream response keeps compute and open timing without inventing a cache acknowledgement', () => {
  const observation = normalizeObservation({ id: 'a', disableCache: true }, {
    status: 'blocked', trace: {
      kind: 'route', productVersion: '0.5.0', timing: { routeMs: 12, openMs: 100, requestMs: 13 },
      result: { status: 'blocked', diagnostics: { searchStats: {} } },
    },
  }, 115)
  assert.equal(observation.status, 'blocked')
  assert.equal(observation.queryMs, 12)
  assert.equal(observation.timing.openMs, 100)
  assert.equal(observation.resultCachePolicy, null)
  assert.equal(observation.wallMs, 115)
})

test('0.5 compute and Python adapter timers keep their different boundaries', () => {
  const detailed = { kind: 'route', productVersion: '0.5.0', timing: { computeMs: 2, openMs: 80, endToEndMs: 90 },
    result: { status: 'ready', durationMinutes: 3, diagnostics: { searchStats: { engineQueryMs: .4 } } } }
  const cli = normalizeObservation({ id: 'a' }, { id: 'a', trace: detailed }, 100)
  assert.equal(cli.queryMs, 2)
  assert.equal(cli.adapterTimingSource, 'timing.computeMs')
  assert.equal(cli.engineQueryMs, .4)
  assert.equal(cli.timing.openMs, 80)
  const python = normalizeObservation({ id: 'a' }, { id: 'a', result: detailed, queryMs: 95,
    timing: { pythonApiAndSerializationMs: 95 } }, 100)
  assert.equal(python.queryMs, 95)
  assert.equal(python.timing.computeMs, 2)
  assert.equal(python.timing.openMs, 80)
  assert.equal(python.engineQueryMs, .4)
})

test('compact VIGO results preserve second clocks, identifiers, geometry and not-found outcomes', () => {
  const payload = { schema: 'vigo.route.v1', status: 'ok', mode: 'transit',
    meta: { engineVersion: '0.5.0', requestId: 'a', computeUs: 2500, computeScope: 'routing_call' },
    journey: { departureTime: '24:00:01', arrivalTime: '24:02:31', durationSeconds: 150, transfers: 0,
      legs: [{ type: 'transit', durationSeconds: 150, departureTime: '24:00:01', arrivalTime: '24:02:31',
        from: { stop: { feed: 'mbta', id: 'A' } }, to: { stop: { feed: 'mbta', id: 'B' } },
        trip: { feed: 'mbta', id: 'T' }, route: { id: { feed: 'mbta', id: 'R' }, name: '1' },
        geometry: { type: 'LineString', coordinates: [[-71, 42], [-71.1, 42.1]] } }] } }
  const result = normalizeObservation({ id: 'a' }, payload, 3)
  assert.equal(result.status, 'ready')
  assert.equal(result.route.durationMinutes, 2.5)
  assert.equal(result.itinerary.departMinutes, 1440 + 1 / 60)
  assert.equal(result.itinerary.legs[0].tripId, 'mbta\u001fT')
  assert.deepEqual(result.itinerary.legs[0].coordinates, payload.journey.legs[0].geometry.coordinates)
  assert.equal(result.queryMs, 2.5)
  assert.equal(result.engineQueryMs, null, 'Full computation is not a search-only measurement')
  assert.deepEqual(result.resultMeta, payload.meta)
  assert.equal(result.resultSchema, 'vigo.route.v1')
  assert(!('publicResult' in result), 'Do not retain duplicate complete journeys and trace in each observation')
  assert.equal(normalizeObservation({ id: 'a' }, { ...payload, journey: null, status: 'not_found' }, 3).status, 'blocked')
  assert.throws(() => normalizeObservation({ id: 'a' }, { ...payload, journey: null }, 3), /timed journey/)
  assert.equal(normalizeObservation({ id: 'a', maxJourneyDurationMinutes: 2 }, payload, 3).outcomeReason, 'native_candidate_rejected')
})

test('both R5 interfaces use the selected corrected source and report missing setup before launch', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-runtime-test-'))
  const retainedNetwork = process.env.VIGO_BENCH_R5_NETWORK
  process.env.VIGO_BENCH_R5_NETWORK = '/diagnostics/retained.graph'
  try {
    const source = path.join(temporary, 'corrected')
    fs.mkdirSync(path.join(source, 'r5py'), { recursive: true })
    fs.writeFileSync(path.join(source, 'r5py', '_benchmark_itinerary_patch.py'), '')
    const jar = path.join(temporary, 'r5.jar')
    fs.writeFileSync(jar, '')
    const context = { city: { slug: 'test', osmPath: '/input/map.pbf', gtfsPaths: ['/input/feed.zip'] },
      workdir: temporary, contextPath: '/run/context.json', od: { odPath: '/run/od.csv' }, maxWalkKm: 1.2 }
    const options = { python: 'python3', r5Adapter: '/scripts/r5-engine-adapter.py', r5Jar: jar, r5pySource: source }
    for (const engine of ['R5', 'R5py']) {
      for (const command of [prepareCommand, queryCommand]) {
        const result = command(engine, context, options)
        assert.equal(result.reason, null)
        assert.equal(result.env.VIGO_BENCH_R5PY_SOURCE, source)
        assert.equal(result.env.VIGO_BENCH_R5_JAR, jar)
        assert.equal(result.env.VIGO_BENCH_ENGINE, engine)
        assert.equal(result.env.VIGO_BENCH_R5_NETWORK, undefined)
        assert.match(command(engine, context, { ...options, r5pySource: path.join(temporary, 'absent') }).reason, /runtime artifact is missing/)
      }
    }
  } finally {
    if (retainedNetwork === undefined) delete process.env.VIGO_BENCH_R5_NETWORK
    else process.env.VIGO_BENCH_R5_NETWORK = retainedNetwork
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('query requests keep first and repeated submissions explicit', () => {
  const rows = [{ id: 'od_1', origin: { coordinate: [-77, 38.9] }, destination: { coordinate: [-77.1, 38.8] } }]
  assert.deepEqual(queryRequests(rows, 2, 'enabled').map(({ repeat, disableCache }) => ({ repeat, disableCache })), [
    { repeat: 1, disableCache: false },
    { repeat: 2, disableCache: false },
  ])
  assert.equal(queryRequests(rows, 1, 'disabled')[0].disableCache, true)
})

test('city discovery keeps every GTFS ZIP in a folder', () => {
  const inputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-city-discovery-'))
  try {
    for (const slug of ['anchorage', 'las_vegas', 'washington']) {
      const directory = path.join(inputRoot, slug)
      fs.mkdirSync(directory)
      fs.writeFileSync(path.join(directory, 'streets.osm.pbf'), '')
      fs.writeFileSync(path.join(directory, 'transit.zip'), '')
    }
    fs.writeFileSync(path.join(inputRoot, 'washington', 'second-feed.zip'), '')
    const cities = discoverCities(inputRoot, ['anchorage', 'las_vegas', 'washington'])
    assert.deepEqual(cities.map((city) => city.slug), ['anchorage', 'las_vegas', 'washington'])
    assert.equal(cities.find((city) => city.slug === 'washington').gtfsPaths.length, 2)
    assert.ok(cities.every(city => city.inputErrors.length === 0))
  } finally { fs.rmSync(inputRoot, { recursive: true, force: true }) }
})

test('service date selection is deterministic across multiple feeds', () => {
  const makeFeed = (calendar) => ({ service: buildServiceModel({ calendar, calendarDates: '' }), counts: {} })
  const feedStats = {
    feeds: [
      makeFeed('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\na,1,1,1,1,1,0,0,20260801,20260831\n'),
      makeFeed('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nb,1,1,1,1,1,0,0,20260803,20260831\n'),
    ],
  }
  const selected = inferServiceDate(feedStats, '')
  assert.equal(selected.date, '2026-08-03')
  assert.equal(inferServiceDay(selected.date, '').day, 'weekday')
})

test('CSV parser handles quoted commas and multiline fields', () => {
  const rows = parseCsv('id,name\n1,"A, B"\n2,"line one\nline two"\n')
  assert.equal(rows[0].name, 'A, B')
  assert.equal(rows[1].name, 'line one\nline two')
})

test('mixed OD weights normalize and allocate an exact deterministic quota', () => {
  const mix = parseOdMix('random=60,stop-to-stop=20,tilt=20')
  assert.deepEqual(mix, { random: 0.6, stop: 0.2, spur: 0.2 })
  assert.deepEqual(allocateOdCounts(1003, mix), { random: 602, stop: 201, spur: 200 })
  assert.deepEqual(allocateOdCounts(5, mix), { random: 3, stop: 1, spur: 1 })
  assert.throws(() => parseOdMix('random=0,stop=0,spur=0'), /positive weight/u)
})

test('GTFS stop extraction keeps valid platforms and ordinary stops only', () => {
  const text = [
    'stop_id,stop_name,stop_lat,stop_lon,location_type',
    'a,Platform,42.1,-71.1,0',
    'b,Legacy blank type,42.2,-71.2,',
    'station,Parent,42.3,-71.3,1',
    'bad,Missing latitude,,-71.4,0',
    '',
  ].join('\n')
  const result = extractGtfsStops(text, 'feed.zip')
  assert.equal(result.sourceRows, 4)
  assert.deepEqual(result.eligible.map((stop) => stop.stopId), ['a', 'b'])
})

test('geodesic spur construction preserves requested offset distance', () => {
  const anchor = [-77.0365, 38.8977]
  for (const distance of [200, 1000]) {
    const moved = destinationPoint(anchor, distance, 127.5)
    assert.ok(Math.abs(haversineDistanceMeters(anchor, moved) - distance) < 1e-6)
  }
})

test('station-pivot rows move both endpoints and keep their stop anchors', () => {
  const stops = [
    { feed: 'rail.zip', stopId: 'a', coordinate: [-77.04, 38.90] },
    { feed: 'rail.zip', stopId: 'b', coordinate: [-77.00, 38.92] },
    { feed: 'bus.zip', stopId: 'c', coordinate: [-77.08, 38.88] },
  ]
  const base = [{ originLon: -77.1, originLat: 38.8, destinationLon: -77.2, destinationLat: 38.7 }]
  const rows = buildStationPivotRows(stops, 4, 20260816, 800, 1200, base)
  assert.equal(rows.length, 4)
  assert.equal(new Set(rows.map((row) => `${row.originAnchor.stopId}>${row.destinationAnchor.stopId}`)).size, 4)
  for (const row of rows) {
    assert.equal(row.odType, 'station_pivot')
    assert.equal(row.spurPattern, 'both')
    assert.notEqual(row.originAnchor.stopId, row.destinationAnchor.stopId)
    assert.ok(row.originOffsetMeters >= 800 && row.originOffsetMeters <= 1200)
    assert.ok(row.destinationOffsetMeters >= 800 && row.destinationOffsetMeters <= 1200)
    assert.ok(Math.abs(haversineDistanceMeters(row.originAnchor.coordinate, row.origin.coordinate) - row.originOffsetMeters) < 1e-6)
    assert.ok(Math.abs(haversineDistanceMeters(row.destinationAnchor.coordinate, row.destination.coordinate) - row.destinationOffsetMeters) < 1e-6)
  }
  assert.deepEqual(buildStationPivotRows(stops, 4, 20260816, 800, 1200, base), rows)
})

test('mixed OD metadata survives CSV serialization and reuse parsing', () => {
  const source = [
    'id,origin_lon,origin_lat,destination_lon,destination_lat,od_type,spur_pattern,origin_anchor_feed,origin_anchor_stop_id,origin_anchor_lon,origin_anchor_lat,origin_offset_m,origin_bearing_deg,destination_anchor_feed,destination_anchor_stop_id,destination_anchor_lon,destination_anchor_lat,destination_offset_m,destination_bearing_deg',
    'od_1,-77.01,38.91,-77.02,38.92,stop_spur,both,bus.zip,a,-77,38.9,500,45,rail.zip,b,-77.03,38.93,750,180',
    '',
  ].join('\n')
  const parsed = parseOdRows(source)
  assert.equal(parsed[0].odType, 'stop_spur')
  assert.equal(parsed[0].originAnchor.stopId, 'a')
  assert.equal(parsed[0].destinationOffsetMeters, 750)
  assert.deepEqual(parseOdRows(serializeOdRows(parsed)), parsed)
})

test('percentiles and warm mean use explicit nearest-rank timing', () => {
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2)
  const observations = [
    { id: 'a1', status: 'ready', queryMs: 10, wallMs: 14, cacheHit: false },
    { id: 'a2', status: 'ready', queryMs: 4, wallMs: 8, cacheHit: true },
    { id: 'a3', status: 'blocked', queryMs: 6, wallMs: 10, cacheHit: null, resultCachePolicy: 'disabled' },
    { id: 'b1', status: 'error', queryMs: 1, wallMs: 2, cacheHit: null },
  ]
  const requestById = new Map([
    ['a1', { repeat: 1 }],
    ['a2', { repeat: 2 }],
    ['a3', { repeat: 3 }],
    ['b1', { repeat: 2 }],
  ])
  const summary = timingSummary(observations, requestById)
  assert.equal(summary.samples, 3)
  assert.equal(summary.meanMs, 20 / 3)
  assert.equal(summary.meanWarmQueryMs, 5)
  assert.equal(summary.first.runnerWall.p50Ms, 14)
  assert.equal(summary.repeated.runnerWall.p50Ms, 8)
  assert.deepEqual(summary.first.cache, { hits: 0, misses: 1, disabled: 0, unreported: 0 })
  assert.deepEqual(summary.repeated.cache, { hits: 1, misses: 0, disabled: 1, unreported: 0 })
})

test('query evidence is summarized separately for each OD category', () => {
  const observations = [
    { id: 'r1', odId: 'random_pair', odType: 'random', status: 'ready', queryMs: 8 },
    { id: 'r2', odId: 'random_pair', odType: 'random', status: 'blocked', queryMs: 4 },
    { id: 's1', odId: 'stop_pair', odType: 'stop_to_stop', status: 'error', queryMs: null },
  ]
  const requests = new Map([
    ['r1', { repeat: 1 }],
    ['r2', { repeat: 2 }],
    ['s1', { repeat: 1 }],
  ])
  const summary = summarizeByOdType(observations, requests)
  assert.deepEqual(summary.random.counts, { ready: 1, blocked: 1, errors: 0 })
  assert.equal(summary.random.pairs, 1)
  assert.equal(summary.random.hot.meanWarmQueryMs, 4)
  assert.deepEqual(summary.stop_to_stop.counts, { ready: 0, blocked: 0, errors: 1 })
})

test('single-engine shorthand selects only the requested engine', () => {
  assert.deepEqual(selectedEngines(parseArguments(['--engine', 'vigo'])), ['VIGO'])
  assert.deepEqual(selectedEngines(parseArguments(['--engines', 'R5,OTP'])), ['R5', 'OTP'])
  assert.deepEqual(selectedEngines(parseArguments(['--engine', 'VIGO-py'])), ['VIGO-py'])
  assert.deepEqual(
    selectedEngines(parseArguments(['--engines', 'graph-hopper'])),
    ['GraphHopper'],
  )
  assert.throws(
    () => selectedEngines(parseArguments(['--engine', 'R5', '--engines', 'VIGO'])),
    /either --engine or --engines/u,
  )
})

test('prior run resolves city-specific OD and recorded pair count', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-bench-reuse-test-'))
  try {
    const cityDirectory = path.join(temporary, 'boston')
    fs.mkdirSync(cityDirectory)
    fs.writeFileSync(path.join(cityDirectory, 'od.csv'), 'id,origin_lon,origin_lat,destination_lon,destination_lat\na,-71,42,-71.1,42.1\nb,-71.2,42.2,-71.3,42.3\n')
    fs.writeFileSync(path.join(temporary, 'summary.json'), `${JSON.stringify({
      controls: { requestedPairs: 2, repeatsPerPair: 3 },
      cities: [{ citySlug: 'boston', od: { path: '/stale/location/od.csv' } }],
    })}\n`)
    const reuseRun = loadReuseRun(temporary)
    assert.equal(reuseOdFile(reuseRun, 'boston'), path.join(cityDirectory, 'od.csv'))
    assert.equal(reusedPairCount(reuseRun, [{ slug: 'boston' }]), 2)
    assert.throws(() => reuseOdFile(reuseRun, 'anchorage'), /has no city anchorage/u)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})


test('a failed City build records a setup error and no routing outcomes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-bench-setup-failure-'))
  try {
    const cli = path.join(directory, 'failing-cli.mjs')
    fs.writeFileSync(cli, "process.stderr.write('insufficient build disk space'); process.exitCode = 2")
    const context = { city: { slug: 'fixture', osmPath: '/input/map.pbf', gtfsPaths: ['/input/a.zip'] },
      cityDirectory: directory, contextPath: path.join(directory, 'context.json'), od: { odPath: '/input/od.csv' },
      routingPreference: 'fastest', requests: [{ id: 'one' }, { id: 'two' }] }
    const { row, observations } = await runEngine(context, 'VIGO', { vigoCli: cli })
    assert.equal(row.status, 'error')
    assert.equal(row.setupErrors, 1)
    assert.equal(row.unsubmittedQueries, 2)
    assert.deepEqual(row.counts, { ready: 0, blocked: 0, errors: 0 })
    assert.deepEqual(observations, [])
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('complete runs persist per-request evidence and separate build/query RSS and storage', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-bench-measurement-'))
  ENGINE_DEFINITIONS.set('MeasurementFixture', { kind: 'external', inputContract: ['osm', 'gtfs'] })
  try {
    const cli = path.join(directory, 'fixture.mjs')
    fs.writeFileSync(cli, `import { createInterface } from 'node:readline';
      if (process.env.VIGO_BENCH_PHASE === 'prepare') {
        process.stderr.write('native preparation log\\n');
        process.stderr.write('x'.repeat(33*1024*1024));
        console.log(JSON.stringify({network:{street:{nodes:2,edges:2,source:'fixture native graph'},transit:{stops:2,trips:1}}}));
      } else {
        process.stderr.write('native query log\\n');
        for await (const line of createInterface({input:process.stdin})) {
          const request=JSON.parse(line);
          console.log(JSON.stringify({id:request.id,status:'blocked',queryMs:0.25}));
        }
      }`)
    const od = { id: 'one', origin: {coordinate:[0,0]}, destination:{coordinate:[1,1]}, odType:'random' }
    const context = { city:{slug:'fixture',osmPath:'/input/map.pbf',gtfsPaths:['/input/a.zip']}, cityDirectory:directory,
      contextPath:path.join(directory,'context.json'), od:{odPath:'/input/od.csv',rows:[od]},
      commonNetworkSize:{street:{source:'input'},transit:{stops:2,trips:1}}, requests:queryRequests([od],1,'disabled') }
    const options = {repeats:1, engineConfig:{engines:{MeasurementFixture:{command:[process.execPath,cli],loads:['osm','gtfs']}}}}
    const {row,observations}=await runEngine(context,'MeasurementFixture',options)
    assert.equal(row.status,'ready')
    assert.equal(row.unsubmittedQueries,0)
    assert.equal(observations.length,1)
    for (const metric of [row.coldPrep.ms,row.coldPrepRss.bytes,row.hotQueryRss.bytes,row.storage.bytes,row.round.queryProcessMs]) assert(metric>0)
    const raw=fs.readFileSync(path.join(row.workdir,'queries.ndjson'),'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(raw[0].id,'one_run_1')
    assert.equal(raw[0].queryMs,0.25)
    assert.match(fs.readFileSync(path.join(row.workdir,'prepare.stderr'),'utf8'),/native preparation log/)
    assert(fs.statSync(path.join(row.workdir,'prepare.stderr')).size>33*1024*1024)
    assert.match(fs.readFileSync(path.join(row.workdir,'query.stderr'),'utf8'),/maximum resident set size/i)
  } finally {
    ENGINE_DEFINITIONS.delete('MeasurementFixture')
    fs.rmSync(directory,{recursive:true,force:true})
  }
})


test('custom workload counts, ranges, source conflicts and defaults are explicit', () => {
  const config = (flags, mode) => workloadConfig(parseArguments(flags), mode)
  assert.deepEqual(config([]).counts, { random: 1000, near_stop: 0, station_pivot: 1000 })
  assert.equal(config(['--near-stop-count', '1000']).total, 3000)
  for (const selected of ['random-count', 'near-stop-count', 'station-pivot-count']) {
    const flags = ['random-count', 'near-stop-count', 'station-pivot-count'].flatMap(key => [`--${key}`, key === selected ? '7' : '0'])
    assert.equal(config(flags).total, 7)
  }
  const appended = config(['--near-stop-count', '1000'], { extending: true })
  assert.deepEqual(appended.counts, { random: 0, near_stop: 1000, station_pivot: 0 })
  assert.throws(() => config(['--near-stop-count', '-1']), /integer/)
  assert.throws(() => config(['--random-count', '0', '--station-pivot-count', '0']), /positive/)
  assert.throws(() => config(['--near-stop-min-m', '401']), /offset range/)
  assert.throws(() => config(['--near-stop-count', '5'], { supplied: true }), /Sampling flags/)
  assert.throws(() => config(['--random-count', '1'], { extending: true }), /preserves/)
  assert.throws(() => config(['--od-mix', 'random=100']), /legacy/)
})

test('three groups preserve the historical corpus, append deterministically, and round-trip for reuse', () => {
  const stops = Array.from({ length: 40 }, (_, i) => ({ feed: 'test.zip', stopId: String(i), coordinate: [-77 + i / 1000, 39 + i / 1000] }))
  const base = parseOdRows('id,origin_lon,origin_lat,destination_lon,destination_lat,od_type\noriginal,-77,39,-76,40,random\n')
  const old = [...base, ...buildStationPivotRows(stops, 1000, 42, 800, 1200, base)]
  const workload = workloadConfig(parseArguments(['--random-count', '1', '--near-stop-count', '1000']))
  const generated = appendWorkload(base, stops, 42, workload)
  assert.deepEqual(generated.slice(0, old.length), old)
  const extension = workloadConfig(parseArguments(['--near-stop-count', '1000']), { extending: true })
  const appended = appendWorkload(old, stops, 42, extension)
  assert.deepEqual(appended, generated)
  validateOdPopulation(appended, 2001)
  assert.equal(appended.filter(row => row.odType === 'near_stop').length, 1000)
  for (const row of appended.filter(row => row.odType === 'near_stop')) {
    assert.ok(row.originOffsetMeters >= 0 && row.originOffsetMeters <= 400)
    assert.ok(row.destinationOffsetMeters >= 0 && row.destinationOffsetMeters <= 400)
    assert.ok(Math.abs(haversineDistanceMeters(row.originAnchor.coordinate, row.origin.coordinate) - row.originOffsetMeters) < 1e-6)
  }
  const restored = parseOdRows(serializeOdRows(appended))
  assert.equal(serializeOdRows(restored), serializeOdRows(appended))
  validateOdPopulation(restored, 2001)
  assert.throws(() => validateOdPopulation([...restored, restored[0]], 2002), /duplicate/)
  assert.throws(() => validateOdPopulation(restored, 2000), /expected/)
  assert.deepEqual(appendWorkload([], [], 42, workloadConfig(parseArguments(['--random-count', '1', '--station-pivot-count', '0']))), [])
})


test('file-backed generation appends a near-stop group and preserves source evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-population-'))
  try {
    const feed = path.join(dir, 'feed.zip')
    execFileSync('python3', ['-c', "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('stops.txt',sys.stdin.read()); z.close()", feed], { input: 'stop_id,stop_lon,stop_lat\na,-77,39\nb,-76,40\nc,-75,41\n' })
    const source = path.join(dir, 'source.csv')
    const original = 'id,origin_lon,origin_lat,destination_lon,destination_lat,od_type\nretained,-77,39,-76,40,random\n'
    fs.writeFileSync(source, original)
    const output = path.join(dir, 'output')
    fs.mkdirSync(output)
    const workload = workloadConfig(parseArguments(['--near-stop-count', '3']), { extending: true })
    const generated = await generateWorkload({ gtfsPaths: [feed] }, 42, output, workload, source)
    assert.deepEqual(generated.stats.typeCounts, { random: 1, near_stop: 3 })
    assert.equal(generated.stats.base.preservedPairs, 1)
    assert.equal(fs.readFileSync(source, 'utf8'), original)
    assert.equal(fs.readFileSync(path.join(output, 'od-source.csv'), 'utf8'), original)
    const saved = parseOdRows(fs.readFileSync(generated.odPath, 'utf8'))
    assert.deepEqual(saved[0], parseOdRows(original)[0])
    validateOdPopulation(saved, 4)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})


test('complete-duration ceiling rejects and preserves final-egress overrun', () => {
  const plan = { status: 'ready', durationMinutes: 243.6, legs: [{ type: 'walk' }] }
  const rejected = normalizeObservation({ id: 'over', maxJourneyDurationMinutes: 240 }, { plan }, 5)
  assert.equal(rejected.status, 'blocked')
  assert.equal(rejected.outcomeReason, 'native_candidate_rejected')
  assert.deepEqual(rejected.policyViolations, ['complete_duration_exceeded'])
  assert.deepEqual(rejected.rejectedItinerary, plan)
  assert.equal(rejected.itinerary, null)
  assert.equal(rejected.nativeStatus, 'ready')
  const onLimit = normalizeObservation({ id: 'equal', maxJourneyDurationMinutes: 240 }, { plan: { ...plan, durationMinutes: 240 } }, 5)
  assert.equal(onLimit.status, 'ready')
  // A timetable horizon by itself is not an end-to-end duration contract.
  const horizonOnly = normalizeObservation({ id: 'horizon', horizonMinutes: 240 }, { plan }, 5)
  assert.equal(horizonOnly.status, 'ready')
})
