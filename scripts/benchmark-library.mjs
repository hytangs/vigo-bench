import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadRun, listRuns, readEvidenceJson, resolveEvidence, readOdComparison } from './benchmark-data.mjs'
import { parseOdRows, DEFAULT_ENGINES } from './run-benchmark.mjs'

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const cityLabel = slug => slug.replaceAll(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
const read = (root, ...parts) => readEvidenceJson(root, path.join(root, ...parts))
const configFrom = (run, city, counts) => {
  const c = run.controls, p = c.comparison ?? {}, g = c.odGeneration ?? {}
  return { city: city.citySlug, serviceDate: city.service?.date ?? '', time: c.time ?? '08:00', maxWalkKm: c.maxWalkKm ?? 1.2,
    candidateLimit: p.candidateLimit ?? 1, maxTransfers: p.maxTransfers ?? 3, horizonMinutes: p.horizonMinutes ?? 240,
    randomCount: counts.random ?? 0, nearStopCount: counts.near_stop ?? 0, stationPivotCount: counts.station_pivot ?? 0,
    nearStopMinMeters: g.nearStopMinMeters ?? 0, nearStopMaxMeters: g.nearStopMaxMeters ?? 400,
    stationPivotMinMeters: g.stationPivotMinMeters ?? 800, stationPivotMaxMeters: g.stationPivotMaxMeters ?? 1200 }
}
export function saveBenchmark(root, benchmark) {
  if (!/^bench-[a-z0-9-]+$/.test(benchmark.id)) throw new Error('Invalid benchmark ID')
  const dir = path.join(root, '.benchmarks')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${benchmark.id}.json`)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(benchmark, null, 2))
  fs.renameSync(`${file}.tmp`, file)
  return benchmark
}
export function createBenchmark(root, config, name = '') {
  if (typeof name !== 'string' || name.length > 100) throw new Error('Use a benchmark name of at most 100 characters')
  return saveBenchmark(root, { id: `bench-${crypto.randomUUID()}`, name: name.trim(), config, createdAt: new Date().toISOString() })
}
export function listBenchmarks(root) {
  const groups = new Map()
  const directory = path.join(root, '.benchmarks')
  if (fs.existsSync(directory)) for (const entry of fs.readdirSync(directory)) {
    if (!/^bench-[a-z0-9-]+\.json$/.test(entry)) continue
    const definition = read(root, '.benchmarks', entry)
    if (definition?.id && definition?.config) groups.set(definition.id, { ...definition, attempts: [], sourceRun: null })
  }
  for (const item of listRuns(root)) {
    let run
    try { run = loadRun(root, item.id) } catch { continue }
    const launch = read(root, '.dashboard-logs', `${item.id}.json`)
    for (const city of run.cities) {
      const recording = city.recording ?? read(root, item.id, city.citySlug, 'recording.json')
      let rows = [], hash = null
      try {
        const csv = fs.readFileSync(resolveEvidence(root, path.join(item.id, city.citySlug, 'od.csv')), 'utf8')
        rows = parseOdRows(csv); hash = digest(csv)
      } catch { /* An interrupted generation can be retried from its definition. */ }
      const counts = rows.reduce((value, row) => { value[row.odType ?? 'unlabeled'] = (value[row.odType ?? 'unlabeled'] ?? 0) + 1; return value }, {})
      const identity = recording?.comparisonId ?? digest([city.citySlug, hash ?? item.id, city.service, run.controls.comparison, run.controls.time, run.controls.maxWalkKm, run.controls.cacheMode])
      let id = launch?.benchmarkId ?? `bench-${identity.slice(0, 24)}`
      const existing = groups.get(id)
      if (existing?.comparisonIdentity && existing.comparisonIdentity !== identity) id = `${id}-${digest(identity).slice(0, 16)}`
      let group = groups.get(id)
      if (!group) {
        group = { id, name: city.displayLabel ?? '', config: configFrom(run, city, counts), createdAt: run.startedAt ?? item.modifiedAt, attempts: [], sourceRun: null }
        groups.set(id, group)
      }
      group.comparisonIdentity = identity
      group.cityLabel = city.city ?? city.citySlug
      group.pairCount = rows.length || group.pairCount || run.controls.requestedPairs
      group.typeCounts = rows.length ? counts : group.typeCounts
      if (rows.length && !group.sourceRun) group.sourceRun = item.id
      group.attempts.push({ id: item.id, label: run.evidenceSnapshot ? run.label : null, startedAt: run.startedAt ?? item.modifiedAt, status: launch?.status ?? run.status ?? (run.completedAt ? 'complete' : 'interrupted'), engines: city.engines.map(lane => lane.engine) })
    }
  }
  return [...groups.values()].map(group => ({ ...group,
    pairCount: group.pairCount ?? group.config.randomCount + group.config.nearStopCount + group.config.stationPivotCount,
    label: group.name || `${group.cityLabel ?? cityLabel(group.config.city)} · ${(group.pairCount ?? group.config.randomCount + group.config.nearStopCount + group.config.stationPivotCount).toLocaleString()} ODs`,
    attempts: group.attempts.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  })).sort((a, b) => (b.attempts[0]?.startedAt ?? b.createdAt).localeCompare(a.attempts[0]?.startedAt ?? a.createdAt))
}
export function getBenchmark(root, id) {
  const result = listBenchmarks(root).find(group => group.id === id)
  if (!result) throw new Error('Benchmark not found')
  return result
}
export function benchmarkResults(root, id, attempt = '') {
  const benchmark = getBenchmark(root, id)
  if (attempt && !benchmark.attempts.some(row => row.id === attempt)) throw new Error('Run does not belong to this benchmark')
  const runs = (attempt ? benchmark.attempts.filter(row => row.id === attempt) : benchmark.attempts).map(row => loadRun(root, row.id))
  const lanes = new Map()
  for (const run of runs) for (const city of run.cities.filter(city => city.citySlug === benchmark.config.city)) {
    for (const lane of city.engines) if (!lanes.has(lane.engine)) lanes.set(lane.engine, { ...lane, runId: run.id, attemptAt: run.startedAt })
  }
  const first = runs[0], city = first?.cities.find(city => city.citySlug === benchmark.config.city)
  return { id, benchmark, label: benchmark.label, controls: first?.controls ?? { ...benchmark.config, requestedPairs: benchmark.pairCount },
    startedAt: first?.startedAt, status: first?.status, evidenceSnapshot: first?.evidenceSnapshot, matrixCoverage: first?.matrixCoverage,
    progress: runs.flatMap(run => run.progress ?? []), warnings: [...new Set(runs.flatMap(run => run.warnings ?? []))],
    cities: [{ city: city?.city ?? benchmark.cityLabel ?? cityLabel(benchmark.config.city), citySlug: benchmark.config.city, service: city?.service, engines: [...lanes.values()].sort((a, b) => DEFAULT_ENGINES.indexOf(a.engine) - DEFAULT_ENGINES.indexOf(b.engine)) }] }
}
export async function benchmarkOds(root, id, attempt = '') {
  const result = benchmarkResults(root, id, attempt)
  const source = attempt || result.benchmark.sourceRun
  if (!source) return { requests: [], warnings: [] }
  return readOdComparison(root, source, result.benchmark.config.city, result.cities[0].engines)
}
// Snapshot only the saved workload and controls. A stopped run needs no final
// summary to be replayable; raw attempts remain untouched and separately named.
export function replayWorkload(root, benchmark) {
  if (!benchmark.sourceRun) return null
  const run = loadRun(root, benchmark.sourceRun), slug = benchmark.config.city
  const city = run.cities.find(city => city.citySlug === slug)
  const recording = city.recording ?? read(root, run.id, slug, 'recording.json')
  const file = resolveEvidence(root, path.join(run.id, slug, 'od.csv'))
  const csv = fs.readFileSync(file)
  const actualHash = crypto.createHash('sha256').update(csv).digest('hex')
  if (recording?.od?.sha256 && recording.od.sha256 !== actualHash) throw new Error('Saved OD file changed; create a new benchmark')
  const directory = path.join(root, '.benchmarks', benchmark.id, actualHash)
  fs.mkdirSync(path.join(directory, slug), { recursive: true })
  fs.writeFileSync(path.join(directory, slug, 'od.csv'), csv)
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ controls: run.controls, cities: [{ ...city, recording, engines: [], od: { ...city.od, path: path.join(directory, slug, 'od.csv') } }] }))
  return directory
}
