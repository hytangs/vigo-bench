import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkPreparationSpace, PREPARATION_DISK_RESERVE } from '../scripts/benchmark-storage.mjs'
import { runEngine } from '../scripts/run-benchmark.mjs'

test('preparation uses available output-volume space and accepts the exact reserve', t => {
  t.mock.method(fs, 'statfsSync', (directory, options) => {
    assert.equal(directory, '/output')
    assert.equal(options.bigint, true)
    return { bavail: BigInt(PREPARATION_DISK_RESERVE), bfree: 999999999999n, bsize: 1n }
  })
  assert.equal(checkPreparationSpace('/output'), PREPARATION_DISK_RESERVE)
})

test('low disk is a setup failure and starts no engine process', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-space-check-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 300n * 1024n, bsize: 1024n }))
  const context = { cityDirectory: root, city: { slug: 'test', label: 'Test', gtfsPaths: [], osmPath: '/missing.osm.pbf' },
    requests: [{ id: 'one' }], routingPreference: 'fastest', od: { odPath: '/unused.csv' } }
  const result = await runEngine(context, 'VIGO', { vigoCli: '/must-never-start.mjs' })
  assert.equal(result.row.status, 'error')
  assert.equal(result.row.setupErrors, 1)
  assert.equal(result.row.counts.blocked, 0)
  assert.equal(result.row.unsubmittedQueries, 1)
  assert.match(result.row.errors[0], /5 GiB free.*0\.29 GiB/)
  assert.equal(fs.existsSync(path.join(root, 'vigo', 'prepare.stdout')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vigo', 'summary.json'))).setupErrors, 1)
})
