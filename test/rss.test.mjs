import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMaxRss } from '../scripts/run-benchmark.mjs'

test('GNU time RSS is not confused with the previous zero-sized metric', () => {
  assert.equal(parseMaxRss('Average total size (kbytes): 0\n\tMaximum resident set size (kbytes): 12345\n'), 12345 * 1024)
})

test('BSD time RSS stays in bytes and missing measurements stay null', () => {
  assert.equal(parseMaxRss('     12,345  maximum resident set size\n'), 12345)
  assert.equal(parseMaxRss('maximum resident set size: 12,345\n'), 12345)
  assert.equal(parseMaxRss('no resource measurement'), null)
})
