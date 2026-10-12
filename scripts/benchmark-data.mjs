import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { DEFAULT_ENGINES, discoverCities, parseOdRows, queryRequests } from './run-benchmark.mjs'
import { ENGINE_TIMING_CONTRACTS } from './benchmark-contracts.mjs'
import { observationGeometry } from '../dashboard/route-geometry.js'

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

// Resolve retained evidence only inside the selected private results root, including symlink targets.
export function resolveEvidence(root, relative, { directory = false } = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('A relative evidence path is required')
  const base = fs.realpathSync(root)
  const candidate = path.resolve(base, relative)
  if (!inside(base, candidate)) throw new Error('Evidence path is outside the results root')
  const resolved = fs.realpathSync(candidate)
  if (!inside(base, resolved)) throw new Error('Evidence symlink is outside the results root')
  if (directory && !fs.statSync(resolved).isDirectory()) throw new Error('Run directory is required')
  return resolved
}

export function readEvidenceJson(root, file) {
  try { return readJson(resolveEvidence(root, path.relative(root, file) || '.')) } catch { return null }
}

const excluded = new Set(['network', 'networks', 'input', 'inputs', 'provenance', 'runtime', 'source', 'node_modules', 'graphs', 'graph', 'tiles', 'venv', 'cache', 'build', 'target', 'snapshots'])
const isRun = (value) => Array.isArray(value?.cities) && value.cities.some(city => Array.isArray(city.engines))
const isCity = (value) => value?.citySlug && Array.isArray(value.engines)
const engineSlug = (name) => name.toLowerCase().replaceAll(/[^a-z0-9]+/giu, '-')
const hasFullQueryTiming = (value) => Boolean(value?.timingContract?.endToEndMs && value?.timingContract?.adapterOverheadMs)

export function listRuns(root) {
  const runs = []
  if (!fs.existsSync(root)) return runs
  root = fs.realpathSync(root)
  function visit(directory, depth) {
    const summary = readEvidenceJson(root, path.join(directory, 'summary.json'))
    const manifest = readEvidenceJson(root, path.join(directory, 'run-manifest.json'))
    const city = isCity(summary)
    if (isRun(summary) || manifest || city) {
      // The summary schema also existed before full-query instrumentation.
      // Use the recorded contract, including for pending and failed runs.
      const current = hasFullQueryTiming(summary) || hasFullQueryTiming(manifest)
        || (city && summary.engines.length > 0 && summary.engines.every(hasFullQueryTiming))
      if (!current) return
      const stat = fs.statSync(path.join(directory, manifest ? 'run-manifest.json' : 'summary.json'))
      const id = path.relative(root, directory) || '.'
      runs.push({ id, label: id, modifiedAt: stat.mtime.toISOString(), startedAt: summary?.startedAt ?? manifest?.startedAt ?? null,
        cities: isRun(summary) ? summary.cities.map(c => c.citySlug) : city ? [summary.citySlug] : (manifest?.cities ?? []).map(c => typeof c === 'string' ? c : c.slug ?? c.citySlug),
        schemaVersion: summary?.schemaVersion ?? manifest?.schemaVersion ?? null })
      return
    }
    if (depth >= 5) return
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory() && !item.name.startsWith('.') && !excluded.has(item.name)
        && !DEFAULT_ENGINES.some(engine => engineSlug(engine) === item.name)) visit(path.join(directory, item.name), depth + 1)
    }
  }
  visit(root, 0)
  return runs.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

export function inputCatalog(inputRoot) {
  try { return discoverCities(inputRoot).map(({ slug, label, inputErrors }) => ({ slug, label, inputErrors })) }
  catch { return [] }
}

function validLanePath(root, runDirectory, city, row) {
  const detail = city.detailFiles?.find(file => file.engine === row.engine)?.file
  const candidates = [
    path.join(runDirectory, city.citySlug ?? '', engineSlug(row.engine)),
    path.join(runDirectory, engineSlug(row.engine)),
    detail ? path.dirname(path.resolve(runDirectory, detail)) : null,
    row.workdir,
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const resolved = resolveEvidence(root, path.relative(root, candidate) || '.', { directory: true })
      if (['summary.json', 'queries.ndjson', 'progress.json'].some(name => fs.existsSync(path.join(resolved, name)))) return resolved
    } catch { /* stale or out-of-root paths never become read permissions */ }
  }
  return null
}

export function loadRun(root, id) {
  root = fs.realpathSync(root)
  const directory = resolveEvidence(root, id, { directory: true })
  const summary = readEvidenceJson(root, path.join(directory, 'summary.json'))
  const manifest = readEvidenceJson(root, path.join(directory, 'run-manifest.json'))
  const warnings = [...(summary?.warnings ?? [])]
  let cities = isRun(summary) ? summary.cities : isCity(summary) ? [summary] : []
  if (!cities.length) {
    const declared = manifest?.cities ?? fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => ({ slug: entry.name, label: entry.name }))
    cities = declared.map(value => {
      const slug = typeof value === 'string' ? value : value.slug ?? value.citySlug
      if (!slug || path.basename(slug) !== slug) return null
      const cityDirectory = path.join(directory, slug)
      const retained = readEvidenceJson(root, path.join(cityDirectory, 'summary.json'))
      if (isCity(retained)) return retained
      const context = readEvidenceJson(root, path.join(cityDirectory, 'context.json'))
      if (!manifest && !context) return null
      const names = manifest?.engines ?? DEFAULT_ENGINES
      const engines = names.map(engine => {
        const workdir = path.join(cityDirectory, engineSlug(engine))
        const row = readEvidenceJson(root, path.join(workdir, 'summary.json'))
        const progress = readEvidenceJson(root, path.join(workdir, 'progress.json'))
        return row ?? { engine, citySlug: slug, workdir, status: progress?.status ?? 'pending',
          counts: progress?.counts ?? ((progress?.completed ?? 0) > 0 ? { ready: null, blocked: null, errors: null } : { ready: 0, blocked: 0, errors: 0 }),
          coldPrep: progress?.coldPrep, coldPrepRss: progress?.coldPrepRss, peakRss: progress?.peakRss,
          setupErrors: progress?.setupErrors ?? 0, unsubmittedQueries: Math.max(0, (progress?.total ?? context?.queryCount ?? manifest?.controls?.timedQueriesPerEngineCity ?? 2000) - (progress?.completed ?? 0)) }
      })
      return { city: context?.city?.label ?? value.label ?? slug, citySlug: slug, engines,
        service: { date: context?.serviceDate ?? manifest?.controls?.serviceDate, time: context?.time ?? manifest?.controls?.time }, od: context?.od }
    }).filter(Boolean)
  }
  if (!cities.length && !manifest) throw new Error('No coordinate benchmark data found in this directory')
  const progress = []
  const lanes = new Map()
  const normalized = cities.map(city => ({ ...city, engines: city.engines.map(row => {
    const laneDirectory = validLanePath(root, directory, city, row)
    const laneId = `${city.citySlug}/${engineSlug(row.engine)}`
    if (laneDirectory) {
      lanes.set(laneId, laneDirectory)
      const current = readEvidenceJson(root, path.join(laneDirectory, 'progress.json'))
      if (current) progress.push({ ...current, laneId, engine: row.engine, city: city.citySlug })
    }
    const adapterReference = ENGINE_TIMING_CONTRACTS[row.engine]
    return { ...row, laneId, measurementContract: row.timingContract ?? summary?.timingContract ?? null,
      timingContract: adapterReference ? { ...adapterReference, limitations: [...adapterReference.limitations,
        'These notes describe current built-in adapter source. Retained or custom runtime provenance may have different timing boundaries.'] } : null,
      evidenceAvailable: Boolean(laneDirectory && fs.existsSync(path.join(laneDirectory, 'queries.ndjson'))) }
  }) }))
  if (summary?.recovery) warnings.push('This retained run contains recovery metadata; inspect provenance before comparing timings.')
  return { id, label: summary?.displayLabel ?? id, evidenceSnapshot: summary?.evidenceSnapshot ?? false, matrixCoverage: summary?.matrixCoverage ?? null, schemaVersion: summary?.schemaVersion ?? manifest?.schemaVersion ?? null,
    controls: summary?.controls ?? manifest?.controls ?? {}, startedAt: summary?.startedAt ?? manifest?.startedAt ?? null,
    completedAt: summary?.completedAt ?? manifest?.completedAt ?? null, status: manifest?.status ?? null,
    cities: normalized, progress, warnings, lanes }
}

const fields = ['id', 'odId', 'odType', 'status', 'outcomeReason', 'repeat', 'wallMs', 'queryMs', 'endToEndMs', 'adapterOverheadMs',
  'requestEncodeMs', 'responseDecodeMs', 'engineQueryMs', 'detail', 'error', 'origin', 'destination', 'route',
  'evidenceSource', 'timingLabel', 'inPrimaryAccuracy', 'inMatchedTiming', 'requestBytes', 'responseBytes', 'adapterOverheadStatus', 'adapterOverheadDeltaMs', 'requestIndex', 'processFirst', 'timingValidity', 'cacheHit', 'resultCachePolicy']


const evidenceCache = new Map()
function savedDisplayEvidence(root, runId, laneId) {
  try {
    const file = resolveEvidence(root, path.join(runId, laneId.split('/')[0], 'dashboard-evidence.json')), stat = fs.statSync(file)
    const key = `${file}:${stat.mtimeMs}:${stat.size}`
    if (!evidenceCache.has(key)) {
      if (evidenceCache.size > 12) evidenceCache.clear()
      evidenceCache.set(key, JSON.parse(fs.readFileSync(file, 'utf8')))
    }
    return evidenceCache.get(key)
  } catch { return null }
}
export function savedObservationView(observation, metadata, lane) {
  if (!metadata) return observation
  const request = metadata.requests?.[observation.id] ?? {}
  const row = { ...request, ...observation, origin: observation.origin ?? request.origin, destination: observation.destination ?? request.destination,
    odId: observation.odId ?? request.odId, odType: observation.odType ?? request.odType, repeat: observation.repeat ?? request.repeat,
    inPrimaryAccuracy: request.inPrimaryAccuracy, inMatchedTiming: request.inMatchedTiming,
    evidenceSource: lane?.evidenceSource, timingLabel: lane?.timingLabel }
  const finalDuration = metadata.durations?.[lane?.engine]?.[row.id]
  if (row.status === 'ready' && Number.isFinite(finalDuration)) {
    row.route = { ...(row.route ?? {}), durationMinutes: finalDuration,
      transfers: row.itinerary?.transfers ?? row.route?.transfers ?? row.plan?.transfers ?? null,
      durationBoundary: 'Final endpoint arrival minus requested departure; includes all walking, waiting, rides, and transfers.' }
  }
  if (lane?.suppressTiming) {
    const timingFields = ['queryMs', 'wallMs', 'endToEndMs', 'engineQueryMs', 'requestEncodeMs', 'responseDecodeMs', 'adapterOverheadMs', 'adapterOverheadDeltaMs']
    row.rawTimingDiagnostic = Object.fromEntries(timingFields.map(key => [key, row[key] ?? null]))
    for (const key of timingFields) row[key] = null
    row.timingValidity = 'accuracy_only_later_replay; original timings remain in historical run'
  }
  return row
}

export async function readOdComparison(root, runId, citySlug, lanes = null) {
  const run = loadRun(root, runId)
  const city = run.cities.find(city => city.citySlug === citySlug)
  if (!city) throw new Error('Choose a city in this run')
  const requests = new Map(), warnings = []
  try {
    const file = resolveEvidence(root, path.join(runId, citySlug, 'od.csv'))
    const ods = parseOdRows(fs.readFileSync(file, 'utf8'))
    const types = new Map(ods.map(od => [od.id, od.odType]))
    for (const request of queryRequests(ods, run.controls.repeatsPerPair ?? 1)) {
      requests.set(request.id, { ...request, odType: types.get(request.odId), engines: {} })
    }
  } catch (error) { warnings.push(`Saved OD corpus unavailable: ${error.message}`) }
  for (const lane of lanes ?? city.engines) {
    if (!lane.evidenceAvailable) continue
    try {
      const data = await readObservations(root, lane.runId ?? runId, lane.laneId)
      warnings.push(...data.warnings)
      for (const row of data.observations) {
        if (!requests.has(row.id)) requests.set(row.id, { id: row.id, odId: row.odId, odType: row.odType, repeat: row.repeat, origin: row.origin, destination: row.destination, engines: {} })
        const request = requests.get(row.id)
        const mismatch = ['origin', 'destination'].some(side => request[side]?.coordinate && row[side]?.coordinate && JSON.stringify(request[side].coordinate) !== JSON.stringify(row[side].coordinate))
        request.engines[lane.engine] = { laneId: lane.laneId, runId: lane.runId ?? runId, id: row.id, status: mismatch ? 'mismatch' : row.status,
          outcomeReason: row.outcomeReason, endToEndMs: row.endToEndMs, queryMs: row.queryMs, route: row.route,
          adapterOverheadMs: row.adapterOverheadMs, engineQueryMs: row.engineQueryMs,
          evidenceSource: row.evidenceSource, timingLabel: row.timingLabel, inPrimaryAccuracy: row.inPrimaryAccuracy, inMatchedTiming: row.inMatchedTiming,
          detail: mismatch ? 'Recorded coordinates differ from this OD; comparison is unavailable.' : row.detail }
      }
    } catch (error) { warnings.push(`${lane.engine}: ${error.message}`) }
  }
  return { city: citySlug, requests: [...requests.values()], warnings }
}

export async function readRoutes(root, runId, laneId, queryId = null) {
  root = fs.realpathSync(root)
  const run = loadRun(root, runId), lane = run.lanes.get(laneId)
  if (!lane) throw new Error('Route data is unavailable')
  const file = resolveEvidence(root, path.relative(root, path.join(lane, 'queries.ndjson')))
  const input = fs.createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity }), routes = []
  try {
    for await (const line of lines) {
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (row.status !== 'ready' || (queryId && row.id !== queryId)) continue
      row = savedObservationView(row, savedDisplayEvidence(root, runId, laneId), run.cities.flatMap(city => city.engines).find(item => item.laneId === laneId))
      routes.push({ id: row.id, odId: row.odId, status: row.status, geometry: observationGeometry(row) })
    }
  } finally { lines.close(); input.destroy() }
  return { routes }
}

export async function readObservations(root, runId, laneId, queryId = null) {
  root = fs.realpathSync(root)
  const run = loadRun(root, runId)
  const lane = run.lanes.get(laneId)
  if (!lane) throw new Error('Query evidence is unavailable for this engine')
  const file = resolveEvidence(root, path.relative(root, path.join(lane, 'queries.ndjson')))
  const observations = []
  let invalid = 0
  const displayMetadata = savedDisplayEvidence(root, runId, laneId)
  const displayLane = run.cities.flatMap(city => city.engines).find(item => item.laneId === laneId)
  const input = fs.createReadStream(file)
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let observation
      try { observation = savedObservationView(JSON.parse(line), displayMetadata, displayLane) } catch { invalid += 1; continue }
      if (queryId !== null) {
        if (observation.id === queryId) return observation
        continue
      }
      observations.push({ sequence: observations.length + 1, ...Object.fromEntries(fields.map(key => [key, observation[key] ?? null])) })
    }
  } finally { lines.close(); input.destroy() }
  if (queryId !== null) throw new Error('Query ID was not found')
  return { observations, warnings: invalid ? [`${invalid} incomplete or invalid evidence line(s) omitted; saved evidence is unchanged.`] : [] }
}
