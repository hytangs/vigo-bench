// Descriptive interface comparisons. Outcome-conditioned cohorts are not causal effects.
const valid = value => Number.isFinite(value) && value >= 0
const bucket = (value, boundaries) => !valid(value) ? 'unreported'
  : boundaries.find(([limit]) => value <= limit)?.[1] ?? 'above-range'
const count = (rows, field) => Object.fromEntries([...new Set(rows.map(field))].sort().map(key => [key, rows.filter(row => field(row) === key).length]))
function strata(rows, key, summarize) {
  return Object.fromEntries(Object.keys(count(rows, key)).map(group => {
    const selected = rows.filter(row => key(row) === group)
    return [group, { observations: selected.length, outcomes: count(selected, row => row.status), fullQuery: summarize(selected, 'endToEndMs', true) }]
  }))
}
export function comparisonObservation(row) {
  const legs = row.itinerary?.legs ?? []
  const hasGeometry = leg => !!(leg?.legGeometry?.points || leg?.geometry?.coordinates?.length || leg?.coordinates?.length)
  const reported = Array.isArray(legs) ? legs.filter(hasGeometry).length : 0
  const geometryRepresentation = row.geometryRepresentation ?? (row.status !== 'ready' ? 'not-applicable'
    : row.engine === 'ULTRA-OSM' ? 'simplified-declared'
      : reported > 0 ? (reported === legs.length ? 'all-legs-have-geometry-unverified' : 'some-leg-geometry-missing')
        : row.itinerary?.points?.coordinates?.length ? 'path-geometry-unverified' : 'geometry-unreported')
  // Retain only reporting fields across lanes; full itineraries stay in NDJSON.
  return { id: row.id, status: row.status, outcomeReason: row.outcomeReason,
    endToEndMs: row.endToEndMs, responseBytes: row.responseBytes, odType: row.odType,
    route: row.route ? { transfers: row.route.transfers, durationMinutes: row.route.durationMinutes } : null,
    geometryRepresentation }
}
export function sensitivityComparison(lanes, commonIds, summarize) {
  const commonSet = new Set(commonIds)
  const ids = new Set(lanes.flatMap(lane => [...lane.rows.keys()]))
  const engines = Object.fromEntries(lanes.map(lane => {
    const rows = [...lane.rows.values()], ready = rows.filter(row => row.status === 'ready')
    const requested = lane.requestedCount ?? ids.size
    const common = commonIds.map(id => lane.rows.get(id)).filter(Boolean)
    const excluded = ready.filter(row => !commonSet.has(row.id))
    return [lane.engine, { complete: lane.complete, setupErrors: lane.setupErrors ?? null, requested, submitted: rows.length,
      unsubmitted: Math.max(0, requested - rows.length), outcomes: count(rows, row => row.status),
      readyCoverage: requested ? ready.length / requested : null,
      outcomeReasons: count(rows, row => row.outcomeReason ?? (row.status === 'blocked' ? 'blocked_reason_unreported' : row.status)),
      allSubmitted: summarize(rows, 'endToEndMs', true), readyOnly: summarize(ready, 'endToEndMs', true),
      commonReady: summarize(common, 'endToEndMs', true), excludedReady: summarize(excluded, 'endToEndMs', true),
      excludedReadyCount: excluded.length,
      byOdType: strata(rows, row => row.odType ?? 'unreported', summarize),
      byTransfers: strata(ready, row => bucket(row.route?.transfers, [[0, '0'], [1, '1'], [2, '2'], [Infinity, '3+']]), summarize),
      byDuration: strata(ready, row => bucket(row.route?.durationMinutes, [[30, '0–30 min'], [60, '30–60 min'], [120, '60–120 min'], [Infinity, '120+ min']]), summarize),
      byGeometryRepresentation: strata(ready, row => row.geometryRepresentation ?? 'geometry-unreported', summarize),
      byResponseBytes: strata(rows, row => bucket(row.responseBytes, [[1024, '0–1 KiB'], [16384, '1–16 KiB'], [65536, '16–64 KiB'], [Infinity, '64+ KiB']]), summarize),
    }]
  }))
  const ratios = []
  for (let i = 0; i < lanes.length; i++) for (let j = i + 1; j < lanes.length; j++) {
    const a = lanes[i], b = lanes[j]
    const ratio = cohort => {
      const numerator = engines[a.engine][cohort].p50Ms, denominator = engines[b.engine][cohort].p50Ms
      return a.complete && b.complete && valid(numerator) && valid(denominator) && denominator > 0 ? numerator / denominator : null
    }
    ratios.push({ numerator: a.engine, denominator: b.engine, metric: 'ratio of p50 endToEndMs',
      commonReady: ratio('commonReady'), allSubmitted: ratio('allSubmitted'), readyOnly: ratio('readyOnly') })
  }
  return { schemaVersion: 'vigo.benchmark.sensitivity.v1', engines, ratios,
    warnings: ['Common-ready conditions on engine outcomes; report all-submission timing and coverage beside it.',
      'All-submission and ready-only ratios use potentially different populations; they are sensitivity descriptions, not paired speedups.',
      'Transfer and duration strata use each engine’s own successful route; membership can differ by engine.',
      'Response bytes and geometry-presence strata do not establish geometry correctness or completeness. Incomplete lanes retain partial distributions and have no ratios.',
      'Candidate rejection does not establish that no compliant route exists. No native algorithm speedup is established.'] }
}
