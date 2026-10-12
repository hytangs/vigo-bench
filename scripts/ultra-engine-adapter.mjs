#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const workdir = path.resolve(required('VIGO_BENCH_WORKDIR'))
const osm = path.resolve(required('VIGO_BENCH_OSM_PBF'))
const gtfs = JSON.parse(required('VIGO_BENCH_GTFS_PATHS_JSON')).map((value) => path.resolve(value))
const context = JSON.parse(fs.readFileSync(required('VIGO_BENCH_CONTEXT'), 'utf8'))
const vigoCli = path.resolve(required('VIGO_BENCH_VIGO_CLI'))
const networkBinary = path.resolve(required('VIGO_BENCH_ULTRA_NETWORK'))
const ultraBinary = path.resolve(required('VIGO_BENCH_ULTRA'))
const kernelBinary = path.resolve(required('VIGO_BENCH_ULTRA_KERNEL'))
const addGraphBinary = path.resolve(required('VIGO_BENCH_ULTRA_ADD_GRAPH'))
const ultraCheckout = path.resolve(required('VIGO_BENCH_ULTRA_CHECKOUT'))
const python = process.env.PYTHON ?? 'python3'
const mergeScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ultra-gtfs-merge.py')

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.stdout.flush?.()
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`missing ${name}`)
  return value
}

function logOutput(name, stdout, stderr) {
  fs.writeFileSync(path.join(workdir, `${name}.stdout`), stdout ?? '')
  fs.writeFileSync(path.join(workdir, `${name}.stderr`), stderr ?? '')
}

function run(command, args, options = {}) {
  let result
  if (options.streamToDisk) {
    const name = options.name ?? path.basename(command)
    const stdoutPath = path.join(workdir, `${name}.stdout`)
    const stderrPath = path.join(workdir, `${name}.stderr`)
    const stdoutFd = fs.openSync(stdoutPath, 'w')
    const stderrFd = fs.openSync(stderrPath, 'w')
    try {
      result = spawnSync(command, args, {
        cwd: options.cwd ?? workdir,
        env: { ...process.env, ...(options.env ?? {}) },
        input: options.input,
        stdio: ['pipe', stdoutFd, stderrFd],
      })
    } finally {
      fs.closeSync(stdoutFd)
      fs.closeSync(stderrFd)
    }
  } else {
    result = spawnSync(command, args, {
      cwd: options.cwd ?? workdir,
      env: { ...process.env, ...(options.env ?? {}) },
      input: options.input,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
    logOutput(options.name ?? path.basename(command), result.stdout ?? '', result.stderr ?? '')
  }
  if (result.error) throw result.error
  if (result.status !== 0) {
    const tail = options.streamToDisk
      ? `${fs.readFileSync(path.join(workdir, `${options.name ?? path.basename(command)}.stderr`), 'utf8')}\n${fs.readFileSync(path.join(workdir, `${options.name ?? path.basename(command)}.stdout`), 'utf8')}`.slice(-8000)
      : `${result.stderr ?? ''}\n${result.stdout ?? ''}`.slice(-8000)
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}\n${tail}`)
  }
  return result
}

function lastJson(stdout) {
  const text = String(stdout).trim()
  try { return JSON.parse(text) } catch { /* the CLI may prefix progress lines */ }
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]) } catch { /* progress output */ }
  }
  throw new Error('command did not print a JSON payload')
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function writeLines(filePath, lines) {
  const fd = fs.openSync(filePath, 'w')
  let buffer = ''
  try {
    for (const line of lines) {
      buffer += `${line}\n`
      if (buffer.length >= 4 * 1024 * 1024) {
        fs.writeSync(fd, buffer)
        buffer = ''
      }
    }
    if (buffer) fs.writeSync(fd, buffer)
  } finally {
    fs.closeSync(fd)
  }
}

function graphStatistics(graphBase) {
  const statisticsPath = `${graphBase}.statistics.txt`
  if (!fs.existsSync(statisticsPath)) return null
  const text = fs.readFileSync(statisticsPath, 'utf8')
  const match = text.match(/StaticGraph with ([\d,]+) vertices and ([\d,]+) edges/u)
  if (!match) return null
  return { nodes: Number(match[1].replaceAll(',', '')), edges: Number(match[2].replaceAll(',', '')), statisticsPath }
}

function exportDimacs(streetStore, outputBase) {
  const mappingPath = `${outputBase}.mapping.sqlite`
  const database = new DatabaseSync(mappingPath)
  try {
    database.exec(`ATTACH DATABASE ${sqlQuote(streetStore)} AS source;`)
    database.exec(`
      PRAGMA journal_mode=OFF;
      PRAGMA synchronous=OFF;
      PRAGMA temp_store=FILE;
      CREATE TABLE vertices(
        node_id INTEGER PRIMARY KEY,
        vertex_id INTEGER NOT NULL UNIQUE,
        lat REAL NOT NULL,
        lon REAL NOT NULL
      );
      INSERT INTO vertices(node_id, vertex_id, lat, lon)
      SELECT node_id, ROW_NUMBER() OVER (ORDER BY node_id)-1, lat, lon
      FROM source.walk_nodes
      ORDER BY node_id;
    `)
    const vertexCount = Number(database.prepare('SELECT COUNT(*) AS count FROM vertices').get().count)
    const edgeCount = Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM source.edges edge
      JOIN vertices source_vertex ON source_vertex.node_id=edge.from_node
      JOIN vertices target_vertex ON target_vertex.node_id=edge.to_node
    `).get().count)
    if (!vertexCount || !edgeCount) throw new Error('ULTRA OSM DIMACS export is empty')
    function* coordinates() {
      yield 'c OSM walking graph exported from the VIGO OSM street graph'
      yield `p aux sp co ${vertexCount}`
      for (const row of database.prepare('SELECT vertex_id, lat, lon FROM vertices ORDER BY vertex_id').iterate()) {
        yield `v ${Number(row.vertex_id) + 1} ${Math.round(Number(row.lon) * 1_000_000)} ${Math.round(Number(row.lat) * 1_000_000)}`
      }
    }
    function* graph() {
      yield 'c directed OSM walking graph exported from the VIGO OSM street graph'
      yield `p sp ${vertexCount} ${edgeCount}`
      for (const row of database.prepare(`
        SELECT source_vertex.vertex_id AS source_vertex,
               target_vertex.vertex_id AS target_vertex,
               edge.distance_m AS distance_m
        FROM source.edges edge
        JOIN vertices source_vertex ON source_vertex.node_id=edge.from_node
        JOIN vertices target_vertex ON target_vertex.node_id=edge.to_node
        ORDER BY source_vertex.vertex_id, target_vertex.vertex_id, edge.way_id, edge.rowid
      `).iterate()) {
        yield `a ${Number(row.source_vertex) + 1} ${Number(row.target_vertex) + 1} ${Math.max(1, Math.ceil(Number(row.distance_m) / (4.8 / 3.6)))}`
      }
    }
    writeLines(`${outputBase}.co`, coordinates())
    writeLines(`${outputBase}.gr`, graph())
    return { vertexCount, edgeCount, coordinatesPath: `${outputBase}.co`, graphPath: `${outputBase}.gr` }
  } finally {
    database.close()
  }
}

function runUltraScript(binary, scriptPath, name) {
  const expectScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ultra-run-script.tcl')
  return run('expect', [expectScript], {
    cwd: ultraCheckout,
    name,
    streamToDisk: true,
    env: { VIGO_ULTRA_BINARY: binary, VIGO_ULTRA_SCRIPT: scriptPath },
  })
}

function prepare() {
  const vigoNetworkDir = path.join(workdir, 'vigo-osm')
  const importer = pathToFileURL(path.resolve(path.dirname(vigoCli), '../src/server/national-osm-store.mjs')).href
  // Export before the public build compacts away the relational street tables.
  // Keep the importer in a child process so its memory is released before ULTRA.
  const vigoResult = run(process.execPath, ['--input-type=module', '-e', [
    `import { buildNationalOsmStore } from ${JSON.stringify(importer)};`,
    `const streetStore = await buildNationalOsmStore(${JSON.stringify({ pbfPath: osm, outputPath: path.join(vigoNetworkDir, 'street-index.sqlite'), buildDrivingProfile: false })});`,
    'console.log(JSON.stringify({ streetStore }));',
  ].join('\n')], { name: 'vigo-network' })
  const vigoPayload = lastJson(vigoResult.stdout)
  const streetStore = vigoPayload.streetStore?.path
  if (!streetStore) throw new Error('VIGO OSM helper did not report a street store')
  const ultraWork = path.join(workdir, 'ultra')
  fs.mkdirSync(ultraWork, { recursive: true })
  const base = path.join(ultraWork, 'walk')
  const graph = exportDimacs(streetStore, base)
  const merge = run(python, [mergeScript, '--output', path.join(ultraWork, 'merged-gtfs'), '--feeds-json', JSON.stringify(gtfs)], { name: 'merge-gtfs' })
  const mergedGtfs = path.join(ultraWork, 'merged-gtfs')
  const service = String(context.serviceDate).replaceAll('-', '')
  const roadGraph = path.join(ultraWork, 'road.graph')
  const gtfsBinary = path.join(ultraWork, 'gtfs.binary')
  const intermediate = path.join(ultraWork, 'intermediate.binary')
  const mergedIntermediate = path.join(ultraWork, 'merged-intermediate.binary')
  const reducedIntermediate = path.join(ultraWork, 'reduced-intermediate.binary')
  const fullRaptor = path.join(ultraWork, 'full-raptor.binary')
  const loadScript = path.join(ultraWork, 'network-load.script')
  fs.writeFileSync(loadScript, [
    `loadDimacsGraph ${base} ${roadGraph}`,
    `parseGTFS ${mergedGtfs}/ ${gtfsBinary}`,
    `gtfsToIntermediate ${gtfsBinary} ${service} ${service} true true ${intermediate}`,
    '',
  ].join('\n'))
  runUltraScript(networkBinary, loadScript, 'ultra-network-load')
  run(addGraphBinary, [intermediate, roadGraph, '4.8', mergedIntermediate], { cwd: workdir, name: 'ultra-add-osm-graph' })
  const reduceScript = path.join(ultraWork, 'reduce-graph.script')
  fs.writeFileSync(reduceScript, `reduceGraph ${mergedIntermediate} ${reducedIntermediate}\n`)
  runUltraScript(networkBinary, reduceScript, 'ultra-reduce-graph')
  const raptorScript = path.join(ultraWork, 'raptor.script')
  fs.writeFileSync(raptorScript, `intermediateToRAPTOR ${reducedIntermediate} ${fullRaptor}\n`)
  runUltraScript(networkBinary, raptorScript, 'ultra-build-raptor')
  const shortcuts = path.join(ultraWork, 'raptor-ultra.binary')
  const shortcutScript = path.join(ultraWork, 'ultra-shortcuts.script')
  fs.writeFileSync(shortcutScript, `computeStopToStopShortcuts ${fullRaptor} ${shortcuts} 900 max 1 false false\n`)
  runUltraScript(ultraBinary, shortcutScript, 'ultra-shortcuts')
  const coreOrder = path.join(ultraWork, 'core-order')
  const coreCh = path.join(ultraWork, 'core-ch')
  const coreRaptor = path.join(ultraWork, 'core-raptor.binary')
  const chScript = path.join(ultraWork, 'ultra-core-ch.script')
  fs.writeFileSync(chScript, `buildCoreCH ${fullRaptor} ${coreOrder} ${coreCh} ${coreRaptor} 14 raptor false bidirectional 256\n`)
  runUltraScript(ultraBinary, chScript, 'ultra-core-ch')
  const coordinateGraph = `${fullRaptor}.graph`
  if (!fs.existsSync(`${coordinateGraph}.coordinates`)) throw new Error(`ULTRA coordinate graph missing: ${coordinateGraph}.coordinates`)
  const preparedGraph = graphStatistics(coordinateGraph) ?? { nodes: graph.vertexCount, edges: graph.edgeCount, statisticsPath: `${coordinateGraph}.statistics.txt` }
  const payload = {
    status: 'ready',
    engine: 'ULTRA-OSM',
    network: {
      street: { nodes: preparedGraph.nodes, edges: preparedGraph.edges, source: 'ULTRA reduced OSM transfer graph; degree-two vertices contracted while preserving stops' },
      transit: {
        feeds: gtfs.length,
        source: 'Reference GTFS counts; ULTRA imports all namespaced GTFS ZIPs for the selected service date',
      },
    },
    artifacts: { shortcuts, coreCh, coordinateGraph, vigoNetworkDir, mergedGtfs },
    native: { upstream: 'ULTRA', mergeLogBytes: merge.stdout.length, rawStreetGraph: { nodes: graph.vertexCount, edges: graph.edgeCount }, reducedStreetGraph: preparedGraph },
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function departureSeconds() {
  const match = String(context.time).match(/^(\d{2}):(\d{2})$/u)
  if (!match) throw new Error(`invalid benchmark time ${context.time}`)
  return Number(match[1]) * 3600 + Number(match[2]) * 60
}

async function query() {
  const artifacts = JSON.parse(fs.readFileSync(path.join(workdir, 'prepare.stdout'), 'utf8').trim())?.artifacts
  if (!artifacts) throw new Error('ULTRA preparation payload is missing artifacts')
  const coordinateGraph = artifacts.coordinateGraph
  const child = spawn(kernelBinary, [artifacts.shortcuts, artifacts.coreCh, coordinateGraph], { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const childClose = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false })
  const iterator = output[Symbol.asyncIterator]()
  let ready = false
  let readyError = null
  let resolveReady
  let rejectReady
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  child.stderr.on('data', (chunk) => {
    if (String(chunk).includes('ULTRA OSM kernel ready:')) {
      ready = true
      resolveReady()
    }
  })
  child.once('error', (error) => { readyError = error; rejectReady(error) })
  child.once('exit', (code, signal) => {
    if (!ready) {
      readyError = new Error(`ULTRA kernel exited before ready: ${signal ?? code}`)
      rejectReady(readyError)
    }
  })
  try {
    await readyPromise
    const endpointSeconds = Math.floor(Number(context.maxWalkKm) * 1000 / (4.8 / 3.6))
    const maximumWalkMeters = Number(context.maxWalkKm) * 1000
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })) {
      if (!line.trim()) continue
      const request = JSON.parse(line)
      const started = performance.now()
      const origin = request.origin.coordinate
      const destination = request.destination.coordinate
      // Charge the coordinate snap to each endpoint walking budget.
      const maximumSnapMeters = maximumWalkMeters
      const fields = [request.id, origin[0], origin[1], destination[0], destination[1], departureSeconds(), context.comparison.maxTransfers + 1, maximumSnapMeters, endpointSeconds, maximumWalkMeters]
      child.stdin.write(`${fields.join('\t')}\n`)
      const next = await iterator.next()
      if (next.done) throw new Error(`ULTRA kernel ended without response for ${request.id}`)
      const response = String(next.value).split('\t')
      const kernelNs = Number(response[response[1] === 'ready' ? 7 : 2])
      const queryMs = performance.now() - started
      if (response[1] === 'ready') {
        const durationMinutes = Number(response[3]) / 60
        const boardings = Number(response[5])
        if (durationMinutes > context.comparison.horizonMinutes) {
          emit({ id: request.id, status: 'blocked', queryMs, rejectedItinerary: JSON.parse(response[22]),
            timing: { engineQueryMs: kernelNs / 1e6 }, detail: 'ULTRA returned a journey beyond the requested horizon.',
            plan: { status: 'blocked', diagnostics: { algorithm: 'ULTRA-RAPTOR with coordinate Core-CH transfers', walkingNetwork: 'osm',
              outcomeReason: 'native_candidate_rejected', policyViolations: ['horizon_exceeded'], unreachabilityProven: false } } })
          continue
        }
        emit({ id: request.id, status: 'ready', queryMs, itinerary: JSON.parse(response[22]), timing: { engineQueryMs: kernelNs / 1e6 }, plan: { status: 'ready', durationMinutes, transfers: Math.max(0, boardings - 1), diagnostics: { algorithm: 'ULTRA-RAPTOR with coordinate Core-CH transfers', walkingNetwork: 'osm' } } })
      } else if (response[1] === 'blocked') {
        emit({ id: request.id, status: 'blocked', queryMs, timing: { engineQueryMs: Number.isFinite(kernelNs) ? kernelNs / 1e6 : null }, detail: response[3] ?? 'ULTRA returned no journey.', plan: { status: 'blocked', diagnostics: { algorithm: 'ULTRA-RAPTOR with coordinate Core-CH transfers', walkingNetwork: 'osm' } } })
      } else {
        emit({ id: request.id, status: 'error', queryMs, error: response.slice(2).join('\t') || 'ULTRA kernel error' })
      }
    }
  } finally {
    child.stdin.end()
    await childClose
    output.close()
  }
}

if (process.env.VIGO_BENCH_PHASE === 'prepare') prepare()
else if (process.env.VIGO_BENCH_PHASE === 'query') query().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
else throw new Error('VIGO_BENCH_PHASE must be prepare or query')
