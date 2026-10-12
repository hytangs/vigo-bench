import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkVigoRuntime, readVigoCityManifest, resolveVigoKernel, vigoRouteRequest } from '../scripts/vigo-runtime.mjs'
import { recordProvenance } from '../scripts/benchmark-recording.mjs'
import { runNdjsonCommand } from '../scripts/run-benchmark.mjs'

test('VIGO wire requests omit benchmark metadata while the caller keeps the duration filter', async () => {
  const request = { id: 'q', odId: 'o', repeat: 1, origin: [-71, 42], destination: [-71.1, 42.1],
    maxJourneyDurationMinutes: 1, maxTransfers: 0, disableCache: true }
  const context = { serviceDate: '2026-10-08', time: '09:13', maxWalkKm: .4,
    comparison: { requireTransitRide: true, maxTransfers: 3, horizonMinutes: 37 } }
  const wire = vigoRouteRequest(request, context)
  assert.equal(wire.maxTransfers, 0)
  assert.equal(wire.time, '09:13')
  assert.equal(wire.horizonMinutes, 37)
  assert(!('odId' in wire) && !('repeat' in wire) && !('maxJourneyDurationMinutes' in wire))
  const fixture = `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({input: process.stdin})) {
      const q = JSON.parse(line);
      if (q.odId || q.maxJourneyDurationMinutes || q.kind !== 'route' || q.time !== '09:13') process.exit(2);
      console.log(JSON.stringify({schema:'vigo.route.v1', status:'ok', meta:{requestId:q.id},
        journey:{durationSeconds:120,departureTime:'09:13:00',arrivalTime:'09:15:00',legs:[]}}));
    }
  `
  const result = await runNdjsonCommand([process.execPath, '--input-type=module', '-e', fixture], [request],
    { encodeRequest: q => vigoRouteRequest(q, context), measureRss: false })
  assert.equal(result.process.code, 0)
  assert.equal(result.observations[0].status, 'blocked')
  assert.equal(result.observations[0].outcomeReason, 'native_candidate_rejected')
  assert.equal(result.observations[0].rejectedItinerary.durationMinutes, 2)
})

test('runtime gate accepts the current extensible command catalog and rejects an old engine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-runtime-mock-'))
  try {
    const cli = path.join(root, 'vigo.mjs')
    const capabilities = { schemaVersion: 'vigo.capabilities.v3', productVersion: '0.5.0', apiVersion: '1.0',
      publicCliCommands: ['build', 'build-scenarios', 'stream', 'route', 'matrix', 'reach'],
      output: { diagnostics: ['none', 'trace'] } }
    fs.writeFileSync(cli, `console.log(JSON.stringify(${JSON.stringify(capabilities)}))`)
    assert.equal(checkVigoRuntime(cli).productVersion, '0.5.0')
    fs.writeFileSync(cli, `console.log(JSON.stringify(${JSON.stringify({ ...capabilities, productVersion: '0.4.4' })}))`)
    assert.throws(() => checkVigoRuntime(cli), /requires Engine 0.5/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('replay rejects an older City before copying or opening it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-manifest-mock-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = { schemaVersion: 'vigo.city.v1', cityFormatVersion: 1, productVersion: '0.5.0' }
  fs.writeFileSync(path.join(root, 'network.json'), JSON.stringify(manifest))
  assert.deepEqual(readVigoCityManifest(root), manifest)
  fs.writeFileSync(path.join(root, 'network.json'), JSON.stringify({ ...manifest, productVersion: '0.4.4' }))
  assert.throws(() => readVigoCityManifest(root), /rebuilt with Engine 0.5/)
})

test('provenance identifies the actual native addon and wrapper source, including local changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-provenance-mock-'))
  try {
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.writeFileSync(path.join(root, 'package.json'), '{}')
    const cli = path.join(root, 'vigo.mjs'), kernel = path.join(root, 'vigo-routing-kernel.node')
    fs.writeFileSync(cli, '// fixture')
    fs.writeFileSync(kernel, 'fixture native bytes')
    assert.equal(resolveVigoKernel(cli, ''), kernel)
    const source = path.join(root, 'wrapper')
    fs.mkdirSync(path.join(source, 'vigo'), { recursive: true })
    const model = path.join(source, 'vigo', 'model.py')
    fs.writeFileSync(model, '# first')
    const options = { vigoCli: cli, vigoKernel: kernel, vigoPythonSource: source }
    const record = async name => {
      const out = path.join(root, name)
      await recordProvenance(root, out, options, ['VIGO', 'VIGO-py'])
      return JSON.parse(fs.readFileSync(path.join(out, 'provenance/manifest.json'))).runtimes
    }
    const first = await record('first')
    assert.equal(first.vigoKernel.bytes, fs.statSync(kernel).size)
    assert.equal(first.vigoPython.files.length, 1)
    fs.writeFileSync(model, '# local edit')
    const second = await record('second')
    assert.notEqual(first.vigoPython.sourceSha256, second.vigoPython.sourceSha256)
    assert.equal(first.vigoKernel.sha256, second.vigoKernel.sha256)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
