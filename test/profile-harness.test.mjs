import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../scripts/profile-harness.mjs', import.meta.url))

test('harness profiler rejects incomplete and corrupted persisted fixtures', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-profile-check-'))
  try {
    const runner = path.join(directory, 'runner.mjs')
    for (const failure of ['missing', 'corrupt']) {
      fs.writeFileSync(runner, String.raw`
import fs from 'node:fs';
export const ENGINE_DEFINITIONS = new Map();
export const timingSummary = () => ({});
export async function runEngine(context) {
  fs.mkdirSync(context.cityDirectory, {recursive:true});
  const observations = context.requests.map(({id}) => ({id,status:'ready',itinerary:{fixture:'x'.repeat(2048)}}));
  if (${JSON.stringify(failure)} === 'missing') observations.pop();
  else observations[0].itinerary.fixture = 'y'.repeat(2048);
  fs.writeFileSync(context.cityDirectory + '/queries.ndjson', observations.map(row=>JSON.stringify(row)).join('\n')+'\n');
  return {row:{workdir:context.cityDirectory,counts:{ready:observations.length,blocked:0,errors:0}},observations};
}
`)
      const output = path.join(directory, `${failure}.json`)
      const run = spawnSync(process.execPath, [script, '--runner', runner, '--count', '2', '--output', output], { encoding: 'utf8' })
      assert.notEqual(run.status, 0)
      assert.match(run.stderr, /Fixture response completeness or content parity failed/)
      assert(!fs.existsSync(output), 'Invalid measurements must not be published')
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('harness profiler validates arguments and retains complete trials without overwriting output', () => {
  for (const args of [['--count', '0'], ['--output'], ['--typo', '1']]) {
    assert.notEqual(spawnSync(process.execPath, [script, ...args]).status, 0)
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-profile-success-'))
  try {
    const output = path.join(directory, 'profile.json')
    execFileSync(process.execPath, [script, '--count', '3', '--output', output], { stdio: 'pipe' })
    const saved = fs.readFileSync(output, 'utf8')
    const result = JSON.parse(saved)
    assert.equal(result.lanes.length, 3)
    assert(result.lanes.every(lane => lane.responses === 3 && lane.counts.ready === 3))
    assert.equal(new Set(result.lanes.map(lane => lane.contentDigest)).size, 1)
    assert.notEqual(spawnSync(process.execPath, [script, '--count', '1', '--output', output]).status, 0)
    assert.equal(fs.readFileSync(output, 'utf8'), saved)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
