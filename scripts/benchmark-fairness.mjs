import { sensitivityComparison } from './benchmark-sensitivity.mjs'
import { ENGINE_TIMING_CONTRACTS } from './benchmark-contracts.mjs'

export function fairnessRecord(engines, cacheMode, controls = {}) {
  return {
    schemaVersion: 'vigo.benchmark.fairness.v1',
    primaryMetric: 'endToEndMs',
    title: 'End-to-end itinerary interface performance',
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
      candidatePolicy: { requestedLimit: ['MOTIS', 'OTP', 'GraphHopper'].includes(engine) ? (controls.candidateLimit ?? 1) : null,
        configurableReturnedLimit: ['MOTIS', 'OTP', 'GraphHopper'].includes(engine),
        exhaustiveCompliantSearch: false },
      boardingPolicy: ['R5', 'R5py'].includes(engine) ? { nativeSlackSeconds: 60, basis: 'documented bundled patched runtime; verify custom runtime provenance', configurable: false, equivalence: 'not established' }
        : { nativeSlackSeconds: null, equivalence: 'not established; requested zero additional slack does not override published transfer rules' },
      implementation: ['R5', 'R5py'].includes(engine) ? 'Patched R5 via Python/r5py bridge; not untouched upstream or pure native Java' : 'See runtime provenance and interface contract',

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
    sensitivity: sensitivityComparison(lanes, common, summarize),
    engines: Object.fromEntries(lanes.map(lane => [lane.engine, { complete: lane.complete, counts: lane.counts,
      fullQuery: summarize(common.map(id => lane.rows.get(id)), 'endToEndMs', true) }])) }
}
