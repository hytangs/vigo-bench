import { ENGINE_TIMING_CONTRACTS } from './benchmark-contracts.mjs'

export function fairnessRecord(engines, cacheMode) {
  return {
    schemaVersion: 'vigo.benchmark.fairness.v1',
    primaryMetric: 'endToEndMs',
    comparisonScope: 'Complete public-interface itineraries, not equal native-kernel work',
    strictNativeEquivalence: false,
    cachePolicy: cacheMode === 'disabled' ? 'diagnostic-disable-where-supported' : 'native-caches-allowed',
    cacheWarning: cacheMode === 'disabled' ? 'Cache disabling is not uniformly supported. In particular, VIGO street-cache disabling has no proven equivalent across all other engines; do not use this lane for an unqualified speed ranking.' : null,
    protocol: ['Same ordered OD CSV, source inputs, service date, departure and requested controls for every selected engine',
      'One submission per OD; fresh preparation and resident query process per lane; no discarded warmup',
      'Report first process request separately from subsequent distinct ODs',
      'Report ready, no-itinerary, setup failure, query error and unsubmitted separately',
      'Engine-native timers and declared adapter timers are diagnostic; compare caller full-query time',
      'Same-ready subsets are descriptive paired comparisons, not proof of route feasibility or optimality'],
    engines: Object.fromEntries(engines.map(engine => [engine, {
      contract: ENGINE_TIMING_CONTRACTS[engine] ?? null,
      extraWork: ['VIGO', 'VIGO-py'].includes(engine) ? 'Public VIGO route responses include fare enrichment and CLI decoration. This extra work remains charged and must accompany interface-level comparisons; no supported fare-free public route option was found.' : null,
      equivalence: 'Native policies and output materialization differ; see contracts and route audit.',
    }])),
  }
}

// Paired descriptive data, with no winner or performance ranking assigned.
export function pairedComparison(lanes, summarize) {
  const eligible = lanes.filter(lane => lane.complete)
  const common = eligible.length === lanes.length && lanes.length >= 2
    ? [...eligible[0].rows.keys()].filter(id => eligible.every(lane => lane.rows.get(id)?.status === 'ready')) : []
  return { primaryMetric: 'endToEndMs', population: 'Same request IDs ready in every selected completed lane',
    readyIsNotFeasibilityProof: true, strictNativeEquivalence: false,
    unavailableReason: eligible.length !== lanes.length ? 'At least one selected lane is incomplete' : lanes.length < 2 ? 'At least two selected lanes are required' : null,
    commonReadyCount: common.length, commonReadyIds: common,
    engines: Object.fromEntries(lanes.map(lane => [lane.engine, { complete: lane.complete, counts: lane.counts,
      fullQuery: summarize(common.map(id => lane.rows.get(id)), 'endToEndMs', true) }])) }
}
