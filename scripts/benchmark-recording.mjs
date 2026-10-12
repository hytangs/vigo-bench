import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { writeJsonAtomic } from './benchmark-evidence.mjs'
import { resolveVigoKernel } from './vigo-runtime.mjs'

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function fingerprint(file) {
  const resolved = fs.realpathSync(file)
  const before = fs.statSync(resolved)
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(resolved)) hash.update(chunk)
  const after = fs.statSync(resolved)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Input changed while recording: ${file}`)
  return { path: path.resolve(file), bytes: after.size, sha256: hash.digest('hex') }
}
export async function inputIdentity(city) {
  const osm = await fingerprint(city.osmPath)
  const gtfs = []
  for (const file of city.gtfsPaths) gtfs.push(await fingerprint(file))
  return { osm, gtfs, digest: digest([osm.sha256, ...gtfs.map(file => file.sha256).sort()]) }
}
export async function recordProvenance(root, output, options, engines = []) {
  const directory = path.join(output, 'provenance')
  fs.mkdirSync(directory, { recursive: true })
  const sources = []
  const copy = async (source, relative) => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue
      const file = path.join(source, entry.name), name = path.join(relative, entry.name)
      if (entry.isDirectory()) await copy(file, name)
      else if (entry.isFile() && !entry.name.endsWith('.pyc')) {
        const target = path.join(directory, name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(file, target)
        sources.push({ ...(await fingerprint(target)), source: file, path: name })
      }
    }
  }
  await copy(path.join(root, 'scripts'), 'scripts')
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'))
  const runtimes = {}
  const keys = { VIGO: ['vigoCli'], 'VIGO-py': ['vigoCli'], R5: ['r5Jar'], R5py: ['r5Jar'], MOTIS: ['motisBinary'], OTP: ['otpJar'], Valhalla: ['valhallaPython'], 'ULTRA-OSM': ['ultraNetwork', 'ultraBinary', 'ultraKernel', 'ultraAddGraph', 'vigoCli'], GraphHopper: ['graphhopperJar'] }
  for (const key of new Set(engines.flatMap(engine => keys[engine] ?? []))) {
    const file = options[key]
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) runtimes[key] = await fingerprint(file)
    else runtimes[key] = { path: file ?? null, available: false }
  }
  if (engines.some(engine => ['VIGO', 'VIGO-py'].includes(engine))) {
    const kernel = options.vigoCli ? resolveVigoKernel(options.vigoCli, options.vigoKernel) : null
    runtimes.vigoNode = await fingerprint(process.execPath)
    runtimes.vigoKernel = kernel && fs.existsSync(kernel) ? await fingerprint(kernel) : { path: kernel, available: false }
  }
  if (engines.includes('VIGO-py')) {
    const source = path.resolve(options.vigoPythonSource ?? process.env.VIGO_BENCH_PYTHON_SOURCE ?? path.resolve(root, '../vigo-py'))
    const pythonFiles = []
    const packageDirectory = path.join(source, 'vigo')
    if (fs.existsSync(packageDirectory)) {
      // Hash source, not bundled City/runtime data or interpreter caches.
      for (const name of fs.readdirSync(packageDirectory).filter(name => name.endsWith('.py')).sort()) {
        pythonFiles.push(await fingerprint(path.join(packageDirectory, name)))
      }
    }
    runtimes.vigoPython = { source, files: pythonFiles,
      sourceSha256: pythonFiles.length ? digest(pythonFiles.map(({ path: file, sha256 }) => [path.basename(file), sha256])) : null }
  }
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).stdout?.trim() ?? null
  const result = { recordedAt: new Date().toISOString(), command: process.argv, node: process.version,
    machine: { platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length, memoryBytes: os.totalmem() },
    git: { commit: git('rev-parse', 'HEAD'), status: git('status', '--short') }, sources, runtimes,
    limitation: 'Configured runtime files are identified; transitive native libraries and operating-system caches are not fully captured.' }
  writeJsonAtomic(path.join(directory, 'manifest.json'), result)
  return { file: 'provenance/manifest.json', sources: sources.length }
}
