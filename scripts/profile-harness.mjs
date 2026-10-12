#!/usr/bin/env node
// Controlled transport/evidence measurements, never native routing results.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({ options: {
  runner: { type: 'string' }, count: { type: 'string', default: '3000' }, output: { type: 'string' },
} })
const runner = path.resolve(args.runner ?? fileURLToPath(new URL('./run-benchmark.mjs', import.meta.url)))
const count = Number(args.count)
if (!Number.isSafeInteger(count) || count < 1) throw new Error('--count must be a positive integer')
const { runEngine, ENGINE_DEFINITIONS, timingSummary } = await import(pathToFileURL(runner))
const observations = Array.from({ length: count }, (_, index) => ({ id: String(index), status: index % 9 === 0 ? 'blocked' : 'ready',
  queryMs: index * 17 % 103, wallMs: index * 17 % 103 + 2, endToEndMs: index * 17 % 103 + 3,
  requestEncodeMs: .1, responseDecodeMs: .9, adapterOverheadMs: 3, adapterOverheadStatus: 'valid', requestIndex: index + 1 }))
const requests = observations.map(({ id }) => ({ id, odId: id, repeat: 1 }))
const byId = new Map(requests.map(row => [row.id, row]))
const statistics = []
let summary
for (let round = 0; round < 5; round++) {
  const start = performance.now()
  summary = timingSummary(observations, byId)
  statistics.push(performance.now() - start)
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-harness-profile-'))
const lanes = []
try {
  const adapter = path.join(directory, 'fixture.mjs')
  fs.writeFileSync(adapter, `import {createInterface} from 'node:readline';
if(process.env.VIGO_BENCH_PHASE==='prepare') console.log(JSON.stringify({network:{street:{nodes:2,edges:1,source:'synthetic'},transit:{stops:2,trips:1}}}));
else for await(const line of createInterface({input:process.stdin})) { const q=JSON.parse(line); console.log(JSON.stringify({id:q.id,status:'ready',queryMs:0,itinerary:{fixture:'x'.repeat(2048)}})); }`)
  const name = 'HarnessFixture'
  ENGINE_DEFINITIONS.set(name, { kind: 'external', inputContract: ['osm', 'gtfs'] })
  for (let round = 0; round < 3; round++) {
    const cityDirectory = path.join(directory, String(round))
    const context = { city: { slug: 'synthetic', osmPath: '/synthetic.pbf', gtfsPaths: [] }, cityDirectory,
      contextPath: path.join(directory, 'context.json'), od: { rows: [], odPath: '/synthetic.csv' },
      commonNetworkSize: { street: { source: 'synthetic' }, transit: { stops: 2, trips: 1 } }, requests }
    const { row, observations: saved } = await runEngine(context, name, { repeats: 1,
      engineConfig: { engines: { [name]: { command: [process.execPath, adapter], loads: ['osm', 'gtfs'] } } } })
    const records = fs.readFileSync(path.join(row.workdir, 'queries.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
    if (JSON.stringify(records) !== JSON.stringify(saved)) throw new Error('On-disk observation parity failed')
    if (saved.length !== count || row.counts.ready !== count || row.counts.blocked !== 0 || row.counts.errors !== 0
      || saved.some((record, index) => record.id !== requests[index].id || record.status !== 'ready'
        || JSON.stringify(record.itinerary) !== JSON.stringify({ fixture: 'x'.repeat(2048) }))) {
      throw new Error('Fixture response completeness or content parity failed')
    }
    lanes.push({ elapsedMs: row.lifecycle.elapsedMs, queryProcessMs: row.round.queryProcessMs,
      responses: saved.length, counts: row.counts, evidenceBytes: fs.statSync(path.join(row.workdir, 'queries.ndjson')).size,
      contentDigest: createHash('sha256').update(JSON.stringify(records.map(r => [r.id, r.status, r.itinerary]))).digest('hex') })
  }
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
const result = { kind: 'synthetic-harness-overhead', measuredAt: new Date().toISOString(), runner, node: process.version, count,
  limitation: 'Controlled protocol fixture; no native engine routing or preparation measured.', statisticsMs: statistics,
  statisticsDigest: createHash('sha256').update(JSON.stringify(summary)).digest('hex'), lanes }
const output = args.output
if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(result, null, 2))
