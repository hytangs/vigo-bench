import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSensitivityRows, distribution, filterObservations, formatNumber, splitPopulation, filterOdRequests } from '../dashboard/app.js'

test('benchmark size presets and custom sizes preserve the exact requested total', () => {
  for (const size of [1, 2, 10, 30, 300, 2000, 3000, 10001]) {
    const parts = splitPopulation(size)
    assert.equal(parts.reduce((sum, part) => sum + part, 0), size)
    assert(parts.every(part => Number.isInteger(part) && part >= 0))
    assert(Math.max(...parts) - Math.min(...parts) <= 1)
  }
  for (const size of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => splitPopulation(size), /positive integer/)
  assert.deepEqual(splitPopulation(7, [false, true, false]), [0, 7, 0])
  assert.deepEqual(splitPopulation(7, [true, false, true]), [4, 0, 3])
  assert.deepEqual(splitPopulation(1, [false, true, true]), [0, 1, 0])
  assert.throws(() => splitPopulation(7, [false, false, false]), /benchmark type/)
})

test('small query durations render without locale precision errors', () => {
  for (const value of [0, 0.001, 0.3, 0.999, 1, 1000]) assert.equal(typeof formatNumber(value), 'string')
  assert.equal(formatNumber(null), '—')
  assert.match(formatNumber(0.001), /001/)
})

test('UI timing excludes missing and negative durations and preserves zero', () => {
  assert.deepEqual(distribution([null, undefined, -2, Infinity, NaN, 0, 10, 20]), {
    samples: 3, p50Ms: 10, p95Ms: 20, p99Ms: 20, meanMs: 10,
  })
})

test('query scopes distinguish first process request, distinct ODs, repeats and errors', () => {
  const rows = [
    { id: 'one', odId: 'a', status: 'ready', requestIndex: 1, processFirst: true, repeat: 1, odType: 'random' },
    { id: 'two', odId: 'b', status: 'blocked', requestIndex: 2, processFirst: false, repeat: 1, odType: 'station_pivot' },
    { id: 'three', odId: 'a', status: 'error', requestIndex: 3, processFirst: false, repeat: 2, odType: 'random' },
    { id: 'historical', status: 'ready', repeat: 1 },
  ]
  assert.deepEqual(filterObservations(rows, { scope: 'processFirst' }).map(row => row.id), ['one'])
  assert.deepEqual(filterObservations(rows, { scope: 'subsequentDistinct' }).map(row => row.id), ['two'])
  assert.deepEqual(filterObservations(rows, { scope: 'repeated', outcome: 'all' }).map(row => row.id), ['three'])
  assert.deepEqual(filterObservations(rows, { odType: 'station_pivot', search: 'B' }).map(row => row.id), ['two'])
  assert.equal(filterObservations(rows, { outcome: 'all' }).length, 4)
})


test('OD search includes no-itinerary, failed and unsubmitted requests independently of lane filters', () => {
  const rows = [{id:'first_run_1',odId:'first',odType:'random',engines:{VIGO:{status:'blocked'}}}, {id:'second_run_1',odId:'second',odType:'near_stop',engines:{}}]
  assert.equal(filterOdRequests(rows).length,2)
  assert.deepEqual(filterOdRequests(rows,'SECOND'),[rows[1]])
  assert.deepEqual(filterOdRequests(rows,'','random'),[rows[0]])
})

test('live sensitivity table shows excluded successes and never times coordinate mismatches', () => {
  const rows = [{id:'a',odType:'random',engines:{A:{status:'ready',endToEndMs:10},B:{status:'ready',endToEndMs:20}}},
    {id:'b',odType:'random',engines:{A:{status:'ready',endToEndMs:100},B:{status:'blocked',endToEndMs:1,outcomeReason:'native_candidate_rejected'}}},
    {id:'c',odType:'near_stop',engines:{A:{status:'mismatch',endToEndMs:999}}}];
  const html=renderSensitivityRows(rows,['A','B'],'random');
  assert.match(html, /<td>A<\/td><td>2 \/ 2<\/td><td>2<\/td><td>0<\/td><td>1<\/td><td>10<\/td><td>10<\/td><td>1<\/td>/);
  assert.match(html, /<td>B<\/td><td>1 \/ 2<\/td><td>2<\/td><td>1<\/td>/);
  assert.doesNotMatch(renderSensitivityRows(rows,['A','B']), /999/);
  assert.match(renderSensitivityRows(rows,['<unsafe>']), /&lt;unsafe&gt;/);
});
