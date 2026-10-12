#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const BENCH_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const TOOLS_ROOT = path.join(BENCH_ROOT, '.engine-tools')
const SOURCE_ROOT = path.join(TOOLS_ROOT, 'sources')

const ENGINES = ['R5', 'GraphHopper', 'ULTRA-OSM']
const GRAPHHOPPER = {
  url: 'https://github.com/graphhopper/graphhopper.git',
  revision: '5aec912ef0c4572f5d504f623cdec7b06d16daf9',
}

function fail(message) {
  throw new Error(message)
}

function display(command, args) {
  process.stdout.write(`\n> ${[command, ...args].join(' ')}\n`)
}

function run(command, args, options = {}) {
  display(command, args)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? BENCH_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  })
  if (result.error) fail(`Could not start ${command}: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : ''
    fail(`${command} exited with ${result.status}${detail}`)
  }
  return options.capture ? String(result.stdout).trim() : ''
}

function canonicalEngine(value) {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')
  const engine = ENGINES.find((candidate) => candidate.toLowerCase().replaceAll(/[^a-z0-9]/gu, '') === normalized)
  if (!engine) fail(`Unknown engine ${value}; choose from ${ENGINES.join(', ')}`)
  return engine
}

function selectedEngines(argv) {
  const index = argv.findIndex((value) => value === '--engines' || value.startsWith('--engines='))
  if (index < 0) return ENGINES
  const token = argv[index]
  const raw = token.includes('=') ? token.slice(token.indexOf('=') + 1) : argv[index + 1]
  if (!raw || raw.startsWith('--')) fail('--engines requires a comma-separated value')
  return [...new Set(raw.split(',').map((value) => canonicalEngine(value.trim())))]
}

function ensureCheckout(name, specification) {
  const shortRevision = specification.revision.slice(0, 10)
  const destination = path.join(SOURCE_ROOT, `${name}-${shortRevision}`)
  fs.mkdirSync(SOURCE_ROOT, { recursive: true })
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true })
    run('git', ['init', '--quiet'], { cwd: destination })
    run('git', ['remote', 'add', 'origin', specification.url], { cwd: destination })
    run('git', ['fetch', '--depth=1', 'origin', specification.revision], { cwd: destination })
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: destination })
  }
  if (!fs.existsSync(path.join(destination, '.git'))) {
    fail(`Refusing to replace non-Git source directory: ${destination}`)
  }
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: destination, capture: true })
  if (head !== specification.revision) {
    fail(`Pinned source directory has unexpected revision ${head}: ${destination}`)
  }
  const dirty = run('git', ['status', '--porcelain'], { cwd: destination, capture: true })
  if (dirty) fail(`Refusing to build a modified source checkout: ${destination}`)
  return destination
}

function executablePath(name) {
  const candidates = [name]
  for (const candidate of candidates.filter(Boolean)) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
    if (!result.error && result.status === 0) return candidate
  }
  fail(`Required build tool is unavailable: ${name}`)
}

function copyExecutable(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  fs.chmodSync(destination, 0o755)
  process.stdout.write(`Installed ${path.relative(BENCH_ROOT, destination)}\n`)
}

function setupGraphHopper() {
  executablePath('git')
  executablePath('mvn')
  const checkout = ensureCheckout('graphhopper', GRAPHHOPPER)
  run('mvn', ['-q', '-pl', 'web', '-am', 'package', '-DskipTests'], { cwd: checkout })
  const target = path.join(checkout, 'web', 'target')
  const jars = fs.readdirSync(target).filter((name) => /^graphhopper-web-.*\.jar$/u.test(name))
  if (jars.length !== 1) fail(`Expected one GraphHopper web JAR in ${target}; found ${jars.join(', ') || 'none'}`)
  copyExecutable(path.join(target, jars[0]), path.join(TOOLS_ROOT, 'graphhopper', 'graphhopper-web.jar'))
  run(process.env.PYTHON ?? 'python3', [path.join(BENCH_ROOT, 'scripts', 'build-graphhopper-walk-speed.py'),
    path.join(TOOLS_ROOT, 'graphhopper', 'graphhopper-web.jar'), checkout,
    path.join(TOOLS_ROOT, 'graphhopper', 'graphhopper-walk-speed.jar')])
}

function setupUltra() {
  run(process.env.PYTHON ?? 'python3', [path.join(BENCH_ROOT, 'scripts', 'build-ultra-directed.py')])
}

function setupR5() {
  const directory = path.join(TOOLS_ROOT, 'r5')
  const original = path.join(directory, 'r5-v7.4-r5py-all.jar')
  if (!fs.existsSync(original)) fail(`Original R5 v7.4-r5py JAR not found: ${original}`)
  const temporary = fs.mkdtempSync(path.join(directory, '.setup-'))
  const python = process.env.PYTHON ?? 'python3'
  try {
    const source = path.join(temporary, 'r5py-earliest')
    const jar = path.join(temporary, 'r5-v7.4-r5py-itineraries.jar')
    run(python, [path.join(BENCH_ROOT, 'scripts', 'prepare-r5py-itineraries.py'), source])
    run(python, [path.join(BENCH_ROOT, 'scripts', 'build-r5-fixed-departure.py'), original, jar])
    fs.rmSync(path.join(directory, 'r5py-earliest'), { recursive: true, force: true })
    fs.renameSync(source, path.join(directory, 'r5py-earliest'))
    fs.renameSync(jar, path.join(directory, path.basename(jar)))
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function usage() {
  return [
    'Build the corrected R5, GraphHopper and ULTRA runtimes.',
    '',
    'Usage:',
    '  npm run setup:expanded-engines -- [--engines R5,GraphHopper,ULTRA-OSM]',
    '',
    `GraphHopper revision: ${GRAPHHOPPER.revision}`,
    'R5 requires r5py 1.0.7 and .engine-tools/r5/r5-v7.4-r5py-all.jar.',
    'ULTRA-OSM requires the existing .engine-tools/ultra source checkout.',
    '',
  ].join('\n')
}

function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(usage())
    return
  }
  fs.mkdirSync(TOOLS_ROOT, { recursive: true })
  const setup = new Map([
    ['R5', setupR5],
    ['GraphHopper', setupGraphHopper],
    ['ULTRA-OSM', setupUltra],
  ])
  for (const engine of selectedEngines(process.argv.slice(2))) {
    process.stdout.write(`\n=== ${engine} ===\n`)
    setup.get(engine)()
  }
  process.stdout.write('\nExpanded engine setup complete.\n')
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
