#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { DEFAULT_ENGINES, discoverCities, workloadConfig, parseArguments } from './run-benchmark.mjs'
import { digest } from './benchmark-recording.mjs'
import { writeJsonAtomic } from './benchmark-evidence.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const defaultStudy = () => ({ version: 1, engines: [...DEFAULT_ENGINES], seed: 20260816,
  serviceDate: null, time: '08:00', maxWalkKm: 1.2, maxTransfers: 3, horizonMinutes: 240, candidateLimit: 1,
  population: { random: 1000, nearStop: 1000, stationPivot: 1000, nearStopMinMeters: 0, nearStopMaxMeters: 400, stationPivotMinMeters: 800, stationPivotMaxMeters: 1200 } })

const populationFields = { random: 'random-count', nearStop: 'near-stop-count', stationPivot: 'station-pivot-count', nearStopMinMeters: 'near-stop-min-m', nearStopMaxMeters: 'near-stop-max-m', stationPivotMinMeters: 'station-pivot-min-m', stationPivotMaxMeters: 'station-pivot-max-m' }
const runtimeFlags = ['vigo-cli', 'vigo-kernel', 'vigo-python-source', 'python', 'r5-jar', 'r5py-source',
  'motis-binary', 'otp-jar', 'valhalla-python', 'valhalla-timezones', 'ultra-checkout', 'ultra-network',
  'ultra-binary', 'ultra-kernel', 'ultra-add-graph', 'graphhopper-jar', 'engine-config']
export function runtimeArguments(flags) {
  for (const key of flags.keys()) if (!['engines', 'input-root', ...runtimeFlags].includes(key)) {
    throw new Error(`Unknown workflow flag --${key}; put study controls in benchmark.json`)
  }
  return [...flags].filter(([key]) => runtimeFlags.includes(key)).flatMap(([key, values]) => [`--${key}`, values.at(-1)])
}
export function validateStudy(value) {
  const defaults = defaultStudy()
  if (!value || value.version !== 1) throw new Error('benchmark.json requires version: 1')
  for (const key of Object.keys(value)) if (!(key in defaults)) throw new Error(`Unknown study setting: ${key}`)
  const config = { ...defaults, ...value, population: { ...defaults.population, ...value.population } }
  for (const key of Object.keys(config.population)) if (!(key in populationFields)) throw new Error(`Unknown population setting: ${key}`)
  if (!Array.isArray(config.engines) || !config.engines.length || config.engines.some(engine => !DEFAULT_ENGINES.includes(engine)) || new Set(config.engines).size !== config.engines.length) throw new Error('engines must be a nonempty unique list of supported interfaces')
  if (!Number.isSafeInteger(config.seed) || config.seed < 0) throw new Error('seed must be a nonnegative integer')
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.time)) throw new Error('time must be HH:MM')
  if (config.serviceDate !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(config.serviceDate) || !Number.isFinite(Date.parse(config.serviceDate)) || new Date(config.serviceDate).toISOString().slice(0,10) !== config.serviceDate)) throw new Error('serviceDate must be YYYY-MM-DD or null for feed inference')
  for (const [key, min, max, integer] of [['candidateLimit', 1, 20, true], ['maxWalkKm', .01, 100, false], ['maxTransfers', 0, 31, true], ['horizonMinutes', 1, 2880, true]]) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < min || config[key] > max || (integer && !Number.isInteger(config[key]))) throw new Error(`Invalid ${key}`)
  }
  for (const [key, value] of Object.entries(config.population)) if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid population ${key}`)
  workloadConfig(parseArguments(populationArgs(config)))
  return config
}
const populationArgs = config => Object.entries(populationFields).flatMap(([key, flag]) => [`--${flag}`, String(config.population[key])])
export const studyIdentity = config => digest(Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'engines')))
export function studyArguments(config, { inputRoot, city, generate = false, reuse = null, output = null, check = false }) {
  const args = ['--input-root', inputRoot, '--cities', city, '--seed', String(config.seed), '--cache-mode', 'native', '--routing-preference', 'fastest', '--time', config.time,
    '--candidate-limit', String(config.candidateLimit ?? 1), '--max-walk', String(config.maxWalkKm), '--max-transfers', String(config.maxTransfers), '--horizon', String(config.horizonMinutes), '--engines', config.engines.join(',')]
  if (config.serviceDate) args.push('--service-date', config.serviceDate)
  if (reuse) args.push('--reuse-run', reuse)
  else args.push(...populationArgs(config))
  if (generate) args.push('--generate-only')
  if (output) args.push('--run-dir', output)
  if (check) args.push('--check')
  return args
}
async function invoke(args) {
  const child = spawn(process.execPath, ['--expose-gc', path.join(ROOT, 'scripts/run-benchmark.mjs'), ...args], { stdio: 'inherit' })
  const handlers = ['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)])
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Benchmark stopped (${signal ?? code}); partial evidence is retained`))) }) }
  finally { for (const [signal, handler] of handlers) process.off(signal, handler) }
}
async function main() {
  const [action, city, ...rest] = process.argv.slice(2)
  if (!action || action === '--help') {
    console.log('npm run bench -- init|check|generate|run CITY [--engines VIGO,MOTIS]\nPut one OSM PBF and all GTFS ZIPs in input/CITY/. Edit input/CITY/benchmark.json.\nExisting --flag commands still work. Every run creates new evidence; no automatic native routing claims.')
    return
  }
  if (action.startsWith('--')) return invoke(process.argv.slice(2))
  if (!['init','check','generate','run'].includes(action) || !/^[a-z0-9][a-z0-9_-]*$/.test(city ?? '')) throw new Error('Use init|check|generate|run and a lowercase city slug')
  const flags = parseArguments(rest)
  const runtime = runtimeArguments(flags)
  const inputRoot = path.resolve(flags.get('input-root')?.at(-1) ?? path.join(ROOT, 'input'))
  const directory = path.join(inputRoot, city), configFile = path.join(directory, 'benchmark.json')
  if (action === 'init') {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify(defaultStudy(), null, 2) + '\n', { flag: 'wx' })
    console.log(`Created ${configFile}\nAdd one OSM PBF and all GTFS ZIPs, then run: npm run bench -- check ${city}`)
    return
  }
  if (!fs.existsSync(configFile)) throw new Error(`Run npm run bench -- init ${city} first`)
  const config = validateStudy(JSON.parse(fs.readFileSync(configFile, 'utf8')))
  if (flags.has('engines')) config.engines = validateStudy({ ...config, engines: flags.get('engines').at(-1).split(',') }).engines
  const discovered = discoverCities(inputRoot, [city])[0]
  if (discovered.inputErrors.length) throw new Error(discovered.inputErrors.join('; '))
  if (action === 'check') return invoke([...studyArguments(config, { inputRoot, city, check: true }), ...runtime])
  const storage = path.join(ROOT, '.workloads', digest(inputRoot).slice(0,12), city)
  fs.mkdirSync(storage, { recursive: true })
  const pointer = path.join(storage, 'latest.json')
  let saved = fs.existsSync(pointer) ? JSON.parse(fs.readFileSync(pointer, 'utf8')) : null
  if (action === 'generate' || !saved) {
    const output = path.join(storage, `workload-${new Date().toISOString().replaceAll(/[:.]/g,'-')}`)
    await invoke([...studyArguments(config, { inputRoot, city, generate: true, output }), ...runtime])
    const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'))
    if (summary.cities[0]?.status !== 'workload-ready') throw new Error(`Workload generation failed; see ${output}`)
    writeJsonAtomic(path.join(output, 'study.json'), config)
    saved = { directory: output, studyDigest: studyIdentity(config) }
    writeJsonAtomic(pointer, saved)
    if (action === 'generate') { console.log(`Saved workload: ${output}`); return }
  }
  if (saved.studyDigest !== studyIdentity(config)) throw new Error(`Study settings changed. Run npm run bench -- generate ${city} to save a new workload`)
  await invoke([...studyArguments(config, { inputRoot, city, reuse: saved.directory, check: true }), ...runtime])
  await invoke([...studyArguments(config, { inputRoot, city, reuse: saved.directory }), ...runtime])
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
