#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { DEFAULT_ENGINES, workloadConfig, parseArguments } from './run-benchmark.mjs'
import { inputCatalog, listRuns, loadRun, readObservations, readOdComparison, readRoutes, readEvidenceJson, resolveEvidence } from './benchmark-data.mjs'
import { createBenchmark, listBenchmarks, getBenchmark, benchmarkResults, benchmarkOds, replayWorkload, saveBenchmark } from './benchmark-library.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const DEFAULTS = { randomCount: 1000, nearStopCount: 0, stationPivotCount: 1000, nearStopMinMeters: 0, nearStopMaxMeters: 400, stationPivotMinMeters: 800, stationPivotMaxMeters: 1200, serviceDate: '', time: '08:00', maxWalkKm: 1.2, maxTransfers: 3, horizonMinutes: 240, candidateLimit: 1 }

export function validateLaunch(value, cities) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a run configuration')
  const city = cities.find(city => city.slug === value.city)
  if (!city || city.inputErrors.length) throw new Error('Choose a city with one OSM PBF and at least one GTFS ZIP')
  const engines = value.engines
  if (!Array.isArray(engines) || !engines.length || engines.some(engine => !DEFAULT_ENGINES.includes(engine)) || new Set(engines).size !== engines.length) throw new Error('Choose one or more supported engines without duplicates')
  const config = { ...DEFAULTS, ...value, engines: [...engines] }
  config.reuseRun = value.reuseRun ?? null
  if (config.reuseRun !== null && (typeof config.reuseRun !== 'string' || !config.reuseRun)) throw new Error('Invalid saved workload')
  config.runKind = value.runKind ?? 'benchmark'
  if (!['benchmark', 'test'].includes(config.runKind)) throw new Error('Run type must be benchmark or test')
  if (config.serviceDate && (!/^\d{4}-\d{2}-\d{2}$/.test(config.serviceDate) || !Number.isFinite(Date.parse(config.serviceDate))
    || new Date(config.serviceDate).toISOString().slice(0, 10) !== config.serviceDate)) throw new Error('Service date must be a valid YYYY-MM-DD date or blank for feed-based selection')
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.time)) throw new Error('Departure time must be HH:MM')
  for (const [key, min, max, integer] of [['candidateLimit', 1, 20, true], ['maxWalkKm', 0.01, 100, false], ['maxTransfers', 0, 31, true], ['horizonMinutes', 1, 2880, true]]) {
    const number = config[key]
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) throw new Error(`Invalid ${key}`)
  }
  for (const key of ['randomCount', 'nearStopCount', 'stationPivotCount', 'nearStopMinMeters', 'nearStopMaxMeters', 'stationPivotMinMeters', 'stationPivotMaxMeters']) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key])) throw new Error(`Invalid ${key}`)
  }
  workloadConfig(parseArguments(['--random-count', String(config.randomCount), '--near-stop-count', String(config.nearStopCount), '--station-pivot-count', String(config.stationPivotCount), '--near-stop-min-m', String(config.nearStopMinMeters), '--near-stop-max-m', String(config.nearStopMaxMeters), '--station-pivot-min-m', String(config.stationPivotMinMeters), '--station-pivot-max-m', String(config.stationPivotMaxMeters)]))
  return Object.fromEntries(['reuseRun', 'runKind', 'city', 'engines', 'serviceDate', 'time', 'maxWalkKm', 'maxTransfers', 'horizonMinutes', 'candidateLimit', 'randomCount', 'nearStopCount', 'stationPivotCount', 'nearStopMinMeters', 'nearStopMaxMeters', 'stationPivotMinMeters', 'stationPivotMaxMeters'].map(key => [key, config[key]]))
}

function tail(file, limit = 48 * 1024) {
  try {
    const handle = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(handle).size
      const buffer = Buffer.alloc(Math.min(size, limit))
      fs.readSync(handle, buffer, 0, buffer.length, Math.max(0, size - buffer.length))
      return buffer.toString('utf8')
    } finally { fs.closeSync(handle) }
  } catch { return '' }
}

async function body(req) {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (Buffer.byteLength(data) > 16_384) throw new Error('Request body is too large')
  }
  return JSON.parse(data)
}

export function createDashboard({ resultsRoot = path.join(ROOT, 'results'), inputRoot = path.join(ROOT, 'input'), runner = path.join(ROOT, 'scripts/run-benchmark.mjs') } = {}) {
  resultsRoot = path.resolve(resultsRoot)
  inputRoot = path.resolve(inputRoot)
  fs.mkdirSync(resultsRoot, { recursive: true })
  resultsRoot = fs.realpathSync(resultsRoot)
  const token = crypto.randomBytes(24).toString('hex')
  let activeRun = null
  let activeChild = null
  let catalogCache = null
  let catalogTime = 0
  const queryCache = new Map()
  const publicActive = () => activeRun ? { ...activeRun } : null
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(data))
  }
  function terminate() {
    if (!activeChild || activeChild.exitCode !== null) return
    try { process.kill(-activeChild.pid, 'SIGTERM') } catch { activeChild.kill('SIGTERM') }
    const child = activeChild
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } }, 5000)
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // Public basemap providers require a Referer; send only our loopback origin,
    // never a retained run ID or query parameters, on cross-origin requests.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    try {
      const address = server.address()
      const expected = `127.0.0.1:${address.port}`
      if (req.headers.host !== expected && req.headers.host !== `localhost:${address.port}`) return json(res, 403, { error: 'Use the loopback dashboard address' })
      const url = new URL(req.url, `http://${expected}`)
      if (req.method === 'POST') {
        if (req.headers['x-benchmark-token'] !== token || (req.headers.origin && ![`http://${expected}`, `http://localhost:${address.port}`].includes(req.headers.origin))) return json(res, 403, { error: 'Run controls are available only from this local dashboard' })
        if (url.pathname === '/api/benchmarks') {
          const value = await body(req)
          const config = validateLaunch({ ...value, runKind: 'benchmark' }, inputCatalog(inputRoot))
          return json(res, 201, createBenchmark(resultsRoot, config, value.name))
        }
        if (url.pathname === '/api/cities') {
          const value = await body(req)
          if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw new Error('Enter a city name')
          const slug = value.name.trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
          if (!slug || slug.length > 80) throw new Error('Use a city name containing letters or numbers')
          fs.mkdirSync(inputRoot, { recursive: true })
          const directory = path.join(inputRoot, slug)
          fs.mkdirSync(directory)
          return json(res, 201, { slug, label: value.name.trim(), directory })
        }
        if (url.pathname === '/api/city-file') {
          const slug = url.searchParams.get('city'), name = url.searchParams.get('name')
          if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug ?? '') || !name || path.basename(name) !== name || !/\.(?:pbf|zip)$/i.test(name)) throw new Error('Choose an OSM PBF or GTFS ZIP file')
          const directory = resolveEvidence(inputRoot, slug, { directory: true }), target = path.join(directory, name)
          if (fs.existsSync(target)) throw new Error('This file already exists; existing city files are never overwritten')
          const temporary = path.join(directory, `.upload-${crypto.randomUUID()}`)
          let bytes = 0
          try {
            await pipeline(req, new Transform({ transform(chunk, encoding, callback) {
              bytes += chunk.length
              callback(bytes > 8 * 1024 ** 3 ? new Error('File exceeds 8 GiB') : null, chunk)
            } }), fs.createWriteStream(temporary, { flags: 'wx' }))
            if (!bytes) throw new Error('The selected file is empty')
            fs.linkSync(temporary, target)
          } finally { fs.rmSync(temporary, { force: true }) }
          return json(res, 201, { name, bytes, city: inputCatalog(inputRoot).find(city => city.slug === slug) })
        }
        if (url.pathname === '/api/run') {
          if (activeChild) return json(res, 409, { error: 'A benchmark is already running. Wait for completion or stop it before launching another.' })
          const requested = await body(req)
          const benchmark = requested.benchmarkId ? getBenchmark(resultsRoot, requested.benchmarkId) : null
          const config = validateLaunch(benchmark ? { ...benchmark.config, engines: requested.engines, reuseRun: null, runKind: 'benchmark' } : requested, inputCatalog(inputRoot))
          if (benchmark) saveBenchmark(resultsRoot, { id: benchmark.id, name: benchmark.name, config: benchmark.config, createdAt: benchmark.createdAt })
          let reuseDirectory = null
          if (benchmark) reuseDirectory = replayWorkload(resultsRoot, benchmark)
          else if (config.reuseRun) {
            const source = loadRun(resultsRoot, config.reuseRun)
            if (!source.cities.some(city => city.citySlug === config.city)) throw new Error('Choose a workload containing this city')
            reuseDirectory = replayWorkload(resultsRoot, { id: `bench-replay-${crypto.randomBytes(6).toString('hex')}`, sourceRun: config.reuseRun, config })
          }
          if (activeChild) return json(res, 409, { error: 'A benchmark is already running. Wait for completion or stop it before launching another.' })
          const id = `${config.runKind === 'test' ? 'test' : 'visual'}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`
          const outputDirectory = path.join(resultsRoot, id)
          const logDirectory = path.join(resultsRoot, '.dashboard-logs')
          fs.mkdirSync(logDirectory, { recursive: true })
          const logFile = path.join(logDirectory, `${id}.log`)
          const fd = fs.openSync(logFile, 'wx')
          let args = ['--expose-gc', runner, '--input-root', inputRoot, '--run-dir', outputDirectory,
            '--cities', config.city, '--engines', config.engines.join(','), '--repeats', '1', '--cache-mode', 'native',
            '--seed', '20260816', '--routing-preference', 'fastest', '--time', config.time, '--max-walk', String(config.maxWalkKm),
            '--candidate-limit', String(config.candidateLimit), '--max-transfers', String(config.maxTransfers), '--horizon', String(config.horizonMinutes)]
          args.push('--random-count', String(config.randomCount), '--near-stop-count', String(config.nearStopCount), '--station-pivot-count', String(config.stationPivotCount), '--near-stop-min-m', String(config.nearStopMinMeters), '--near-stop-max-m', String(config.nearStopMaxMeters), '--station-pivot-min-m', String(config.stationPivotMinMeters), '--station-pivot-max-m', String(config.stationPivotMaxMeters))
          if (config.serviceDate) args.push('--service-date', config.serviceDate)
          if (reuseDirectory) args = ['--expose-gc', runner, '--input-root', inputRoot, '--run-dir', outputDirectory, '--cities', config.city, '--engines', config.engines.join(','), '--reuse-run', reuseDirectory]
          activeRun = { id, benchmarkId: benchmark?.id ?? null, status: 'running', outputDirectory, startedAt: new Date().toISOString(), exitCode: null, config }
          fs.writeFileSync(path.join(logDirectory, `${id}.json`), JSON.stringify(activeRun, null, 2))
          activeChild = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] })
          fs.closeSync(fd)
          const child = activeChild
          child.on('error', error => { activeRun.error = error.message })
          child.once('close', (code, signal) => {
            const manifest = readEvidenceJson(resultsRoot, path.join(outputDirectory, 'run-manifest.json'))
            activeRun = { ...activeRun, status: activeRun.status === 'stopping' ? 'interrupted' : code === 0 ? (manifest?.status ?? 'complete') : 'failed',
              completedAt: new Date().toISOString(), exitCode: code, signal }
            fs.writeFileSync(path.join(logDirectory, `${id}.json`), JSON.stringify(activeRun, null, 2))
            activeChild = null
            catalogCache = null
            queryCache.clear()
          })
          catalogCache = null
          return json(res, 202, publicActive())
        }
        if (url.pathname === '/api/stop') {
          const data = await body(req)
          if (!activeChild || data.id !== activeRun.id) return json(res, 409, { error: 'This run is not active in this dashboard' })
          activeRun.status = 'stopping'
          terminate()
          return json(res, 202, publicActive())
        }
        return json(res, 404, { error: 'Unknown action' })
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' })
      if (url.pathname === '/api/catalog') {
        if (!catalogCache || Date.now() - catalogTime > 15_000) {
          catalogCache = listRuns(resultsRoot)
          catalogTime = Date.now()
        }
        const runs = [...catalogCache]
        if (activeRun && !runs.some(run => run.id === activeRun.id)) runs.unshift({ id: activeRun.id, label: activeRun.id, modifiedAt: activeRun.startedAt })
        return json(res, 200, { engines: DEFAULT_ENGINES, cities: inputCatalog(inputRoot), runs, benchmarks: listBenchmarks(resultsRoot), activeRun: publicActive(), defaults: DEFAULTS, token })
      }
      if (url.pathname === '/api/benchmark') return json(res, 200, benchmarkResults(resultsRoot, url.searchParams.get('id'), url.searchParams.get('attempt') ?? ''))
      if (url.pathname === '/api/benchmark/ods') return json(res, 200, await benchmarkOds(resultsRoot, url.searchParams.get('id'), url.searchParams.get('attempt') ?? ''))
      if (url.pathname === '/api/routes') return json(res, 200, await readRoutes(resultsRoot, url.searchParams.get('run'), url.searchParams.get('lane'), url.searchParams.get('id')))
      if (url.pathname === '/api/run') {
        const id = url.searchParams.get('id')
        let run
        try { run = loadRun(resultsRoot, id) }
        catch (error) {
          if (id !== activeRun?.id || !['running', 'stopping'].includes(activeRun.status)) throw error
          run = { id, label: id, cities: [], controls: activeRun.config, progress: [], warnings: [], startedAt: activeRun.startedAt }
        }
        const { lanes, ...result } = run
        const launch = id && path.basename(id) === id ? readEvidenceJson(resultsRoot, path.join(resultsRoot, '.dashboard-logs', `${id}.json`)) : null
        let activity = id === activeRun?.id ? publicActive() : launch
        if (activity && id !== activeRun?.id && ['running', 'starting', 'stopping'].includes(activity.status)) {
          activity = { ...activity, status: 'untracked', controlled: false }
          result.warnings.push('This run was launched by an earlier dashboard session; its process state is unknown. Inspect the retained log before starting another run.')
        }
        if (activity && !['running', 'starting', 'stopping'].includes(activity.status)) {
          result.status = activity.status
          result.completedAt = activity.completedAt ?? result.completedAt
        }
        return json(res, 200, { ...result, runKind: activity?.config?.runKind ?? 'benchmark', activeRun: activity })
      }
      if (url.pathname === '/api/ods') {
        return json(res, 200, await readOdComparison(resultsRoot, url.searchParams.get('run'), url.searchParams.get('city')))
      }
      if (url.pathname === '/api/queries' || url.pathname === '/api/query') {
        const runId = url.searchParams.get('run')
        const laneId = url.searchParams.get('lane')
        if (url.pathname === '/api/query') return json(res, 200, await readObservations(resultsRoot, runId, laneId, url.searchParams.get('id')))
        const run = loadRun(resultsRoot, runId)
        const directory = run.lanes.get(laneId)
        if (!directory) throw new Error('Query evidence is unavailable for this engine')
        const file = resolveEvidence(resultsRoot, path.relative(resultsRoot, path.join(directory, 'queries.ndjson')))
        const stat = fs.statSync(file)
        const key = `${file}:${stat.mtimeMs}:${stat.size}`
        let data = queryCache.get(key)
        if (!data) {
          data = await readObservations(resultsRoot, runId, laneId)
          if (queryCache.size >= 12) queryCache.delete(queryCache.keys().next().value)
          queryCache.set(key, data)
        }
        return json(res, 200, data)
      }
      if (url.pathname === '/api/log') {
        const id = url.searchParams.get('run')
        const safeTail = (file, limit) => {
          try { return tail(resolveEvidence(resultsRoot, path.relative(resultsRoot, file)), limit) } catch { return '' }
        }
        let log = ''
        if (id && path.basename(id) === id) log = safeTail(path.join(resultsRoot, '.dashboard-logs', `${id}.log`))
        if (!log) {
          const run = loadRun(resultsRoot, id)
          const recent = [...run.lanes.entries()].slice(-3)
          log = recent.map(([lane, directory]) => `${lane}\n${safeTail(path.join(directory, 'query.stderr'), 8000) || safeTail(path.join(directory, 'prepare.stderr'), 8000)}`).join('\n\n')
        }
        return json(res, 200, { text: log, status: id === activeRun?.id ? activeRun.status : 'retained' })
      }
      const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/map.js', ['map.js', 'text/javascript']],
        ['/comparison-chart.js', ['comparison-chart.js', 'text/javascript']],
        ['/route-geometry.js', ['route-geometry.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
        ['/vendor/leaflet.js', ['../node_modules/leaflet/dist/leaflet.js', 'text/javascript']],
        ['/vendor/leaflet.css', ['../node_modules/leaflet/dist/leaflet.css', 'text/css']],
        ...['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png'].map(file => [`/vendor/images/${file}`, [`../node_modules/leaflet/dist/images/${file}`, 'image/png']])])
      const asset = files.get(url.pathname)
      if (!asset) return json(res, 404, { error: 'Not found' })
      const assetFile = path.join(ROOT, 'dashboard', asset[0])
      if (!fs.existsSync(assetFile)) return json(res, 404, { error: 'Asset not found; run npm install first' })
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' })
      fs.createReadStream(assetFile).pipe(res)
    } catch (error) {
      if (!res.headersSent) json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message })
      else res.end()
    }
  })
  return { server, terminate,
    async waitForIdle() { if (activeChild) await new Promise(resolve => activeChild.once('close', resolve)) },
    get activeRun() { return publicActive() } }
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: npm run dashboard -- [--port 4173] [--results-root PATH] [--input-root PATH]\nLocal benchmark results, complete query timing, and fresh all-engine runs. Binds only to 127.0.0.1.')
  } else {
    const value = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] }
    const port = Number(value('--port', 4173))
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port')
    const app = createDashboard({ resultsRoot: value('--results-root', path.join(ROOT, 'results')), inputRoot: value('--input-root', path.join(ROOT, 'input')) })
    app.server.on('error', error => { console.error(error.message); process.exitCode = 1 })
    app.server.listen(port, '127.0.0.1', () => console.log(`VIGO Bench: http://127.0.0.1:${app.server.address().port}\nPrivate results: ${value('--results-root', path.join(ROOT, 'results'))}`))
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      app.terminate()
      app.server.close()
      if (!app.activeRun || !['running', 'stopping'].includes(app.activeRun.status)) process.exitCode = 0
    })
  }
}
