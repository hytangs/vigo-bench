import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function resolveVigoPythonSource(root, explicit = process.env.VIGO_BENCH_PYTHON_SOURCE) {
  if (explicit?.trim()) return path.resolve(explicit)
  const candidates = [path.resolve(root, '../vigo/python'), path.resolve(root, '../vigo-py')]
  return candidates.find(source => fs.existsSync(path.join(source, 'vigo', '__init__.py'))) ?? candidates[0]
}

export function supportedVigoVersion(version) {
  return /^(?:0\.5|1\.0)\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version ?? '')
}

export function resolveVigoKernel(cli, explicit = process.env.VIGO_NATIVE_ROUTING_KERNEL) {
  if (explicit?.trim()) return path.resolve(explicit)
  const directory = path.dirname(cli)
  return [path.join(directory, 'vigo-routing-kernel.node'),
    path.resolve(directory, '../crates/vigo-runtime/vigo-routing-kernel.node'),
    path.resolve(directory, '../native/vigo-routing-kernel/vigo-routing-kernel.node'),
    path.resolve(directory, '../../native/vigo-routing-kernel/vigo-routing-kernel.node')]
    .find(file => fs.existsSync(file)) ?? null
}

export function checkVigoRuntime(cli, kernel) {
  if (kernel && !fs.existsSync(kernel)) throw new Error(`VIGO native addon missing: ${kernel}`)
  const command = [process.execPath, cli, 'capabilities']
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, ...(kernel ? { VIGO_NATIVE_ROUTING_KERNEL: kernel } : {}) } })
  let capabilities
  try { capabilities = JSON.parse(result.stdout) } catch { /* Rejected below. */ }
  if (result.error || result.status !== 0 || capabilities?.schemaVersion !== 'vigo.capabilities.v3'
    || !supportedVigoVersion(capabilities?.productVersion)
    || capabilities?.apiVersion !== '1.0'
    || !['build', 'stream', 'route', 'matrix', 'reach'].every(name => capabilities?.publicCliCommands?.includes(name))
    || !capabilities?.output?.diagnostics?.includes('trace')) {
    throw new Error(`VIGO benchmark requires Engine 0.5 or 1.0 with the public stream API. Rebuild the selected CLI runtime. ${result.error?.message ?? result.stderr?.trim() ?? ''}`.trim())
  }
  return capabilities
}

export function readVigoCityManifest(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'network.json'), 'utf8'))
  if (manifest?.schemaVersion !== 'vigo.city.v1' || manifest?.cityFormatVersion !== 1
    || !supportedVigoVersion(manifest?.productVersion)) {
    throw new Error('This runner requires a City rebuilt with Engine 0.5 or 1.0; retained older Cities must not be reused.')
  }
  return manifest
}

export function vigoRouteRequest(request, context) {
  // Workload bookkeeping and the complete-duration filter belong to the caller.
  return { id: request.id, kind: 'route', origin: request.origin, destination: request.destination,
    mode: request.mode ?? 'transit', objective: request.objective ?? 'earliest_arrival',
    serviceDate: request.serviceDate ?? context.serviceDate, time: request.time ?? context.time,
    timePreference: request.timePreference ?? 'depart_at', maxWalkKm: request.maxWalkKm ?? context.maxWalkKm,
    requireTransitRide: request.requireTransitRide ?? context.comparison?.requireTransitRide ?? true,
    maxTransfers: request.maxTransfers ?? context.comparison?.maxTransfers,
    horizonMinutes: request.horizonMinutes ?? context.comparison?.horizonMinutes,
    disableCache: request.disableCache === true,
    ...(request.waypoints ? { waypoints: request.waypoints } : {}),
    ...(request.departureWindowMinutes !== undefined ? { departureWindowMinutes: request.departureWindowMinutes } : {}),
  }
}
