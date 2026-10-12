import test from 'node:test'
import assert from 'node:assert/strict'
import { savedObservationView } from '../scripts/benchmark-data.mjs'
import { minuteClock, renderItineraryLegs, renderAccuracyRows } from '../dashboard/app.js'

test('saved corrected accuracy keeps final duration and raw diagnostic timer separate', () => {
  const raw = { id: 'od_run_1', status: 'ready', queryMs: 50, endToEndMs: 52, itinerary: { transfers: 1, endTime: '2026-09-06T13:00:00Z' } }
  const metadata = { requests: { od_run_1: { odId: 'od', origin: { coordinate: [1, 2] }, inPrimaryAccuracy: true } }, durations: { Valhalla: { od_run_1: 60 } } }
  const view = savedObservationView(raw, metadata, { engine: 'Valhalla', suppressTiming: true, timingLabel: 'Accuracy correction only' })
  assert.equal(view.route.durationMinutes, 60)
  assert.equal(view.queryMs, null)
  assert.equal(view.endToEndMs, null)
  assert.equal(view.rawTimingDiagnostic.endToEndMs, 52)
  assert.equal(view.inPrimaryAccuracy, true)
  assert.equal(raw.queryMs, 50)
  assert.equal(raw.route, undefined)
  const unmatched = savedObservationView({ ...raw, origin: { coordinate: [8, 9] } }, metadata, { engine: 'Valhalla' })
  assert.deepEqual(unmatched.origin.coordinate, [8, 9])
})

test('leg display covers VIGO minute clocks/names and Valhalla native maneuvers', () => {
  assert.equal(minuteClock(480), '08:00:00')
  assert.equal(minuteClock(532.5), '08:52:30')
  assert.equal(minuteClock(1440), '00:00:00 (+1d)')
  const vigo = renderItineraryLegs({ itinerary: { legs: [{ type: 'ride', routeShortName: '4', fromName: 'Origin station', toName: 'Destination station', startMinutes: 480, endMinutes: 532.5, durationMinutes: 52.5 }] } })
  assert.match(vigo, /Origin station/)
  assert.match(vigo, /Destination station/)
  assert.match(vigo, /08:52:30/)
  assert.match(vigo, /ride · 4/)
  const native = renderItineraryLegs({ itinerary: { legs: [{ maneuvers: [{ travel_mode: 'transit', time: 120, transit_info: { short_name: 'Green', transit_stops: [{ name: 'Start', departure_date_time: '08:00' }, { name: 'End', arrival_date_time: '08:02' }] } }] }] } })
  assert.match(native, /transit · Green/)
  assert.match(native, /Start → End/)
  assert.match(native, /08:00 → 08:02/)
  assert.match(native, /2 min/)
})

test('accuracy display keeps paired denominator, timing cohort, and signed gap explicit', () => {
  const html = renderAccuracyRows([{ engine: 'MOTIS', evidenceSource: 'Point variant <diagnostic>', accuracy: { n: 1000, requestedCohortN: 1200, pearsonR: 0.87654321, medianAbsoluteDifferenceMinutes: 4.25, medianSignedDifferenceMinutes: -1.5, timingMatchedN: 1200, residentTimingN: 1199 } }])
  assert.match(html, /1,000 \/ 1,200/)
  assert.match(html, /0\.876543/)
  assert.match(html, /4\.25/)
  assert.match(html, /1,200 \/ 1,199/)
  assert.match(html, /&lt;diagnostic&gt;/)
})
