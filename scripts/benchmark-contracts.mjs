// These describe the built-in adapters, not arbitrary --engine-config overrides.
// Keep the declared timers diagnostic: their boundaries differ across engines.
// All references below are source paths, not claims that a retained binary was
// rebuilt from those sources. Run provenance must establish the actual runtime.
const contracts = {
  // ../vigo/src/cli/vigo.ts: computeRouteRequest, runRouteStream, writeNdjson.
  // ../vigo/src/server/national-gtfs-store.mjs: searchStats.engineQueryMs.
  VIGO: {
    adapterBoundary: 'The current timing.computeMs counter includes routing, plan materialization and fare enrichment. It excludes input decoding, lazy prepareMode/open, public-result formatting and NDJSON serialization/output. meta.computeUs expresses this counter in microseconds.',
    coreBoundary: 'Optional searchStats.engineQueryMs reports native timetable search, with additional search passes summed when used. It is not a complete coordinate-to-itinerary timer.',
    limitations: [
      'Native coordinate access, walking geometry and plan construction are not uniformly covered by the timetable counter; inspect the retained search diagnostics.',
      'Trace openMs records lazy preparation separately. The first runner request also waits for runtime startup and opening; none of it is subtracted from caller timing.',
      'Trace is requested for detailed evidence. Its formatting, bytes and caller decoding remain charged to endToEndMs. Missing counters remain missing; search-only time is never substituted for a full-call timer.',
    ],
  },
  // scripts/python-api-adapter.py; ../vigo-py/vigo/model.py: City._route,
  // _QueryStream, Result.to_json.
  'VIGO-py': {
    adapterBoundary: 'City.route through Result.to_json(indent=None), including any lazy opening inside that call. Includes Python validation/wrapper work, runtime IPC, plan decoding and result serialization; the final benchmark envelope and stdout write occur afterward.',
    coreBoundary: 'Optional VIGO searchStats.engineQueryMs is inherited from the underlying route plan, with the same timetable-search boundary as VIGO.',
    limitations: [
      'vigo.open runs before the request timer, but lazy resident-process creation occurs inside the first City.route. No startup/open time is subtracted from the declared duration.',
      'pythonApiAndSerializationMs preserves the unadjusted adapter duration. Result.to_json serializes the current detailed Python Result with no opening-time subtraction.',
      'The outer runner still decodes the complete benchmark response; that work is outside this declared timer.',
    ],
  },
  // scripts/native-engine-adapter.py: motis_query, http_json, query_motis.
  MOTIS: {
    adapterBoundary: 'URL encoding and the local HTTP request through full response read and JSON decoding. Includes server routing, itinerary construction and server serialization; adapter candidate selection and final NDJSON encoding occur afterward.',
    coreBoundary: 'No native search timer is exported by this adapter.',
    limitations: [
      'The request parameter dictionary is built before the declared timer.',
      'Server launch, graph loading and health checks precede the adapter query timer but delay the first runner response.',
      'HTTP duration cannot be treated as a search-only core measurement.',
      'The resident adapter reuses its loopback HTTP connection and feed timezone metadata; full response read/decoding remains timed and failed requests are never retried.',
    ],
  },
  // scripts/ultra-engine-adapter.mjs: query; scripts/ultra-osm-kernel.cpp: main.
  'ULTRA-OSM': {
    adapterBoundary: 'Request-field construction through kernel IPC and receipt/splitting of the complete kernel response. Includes coordinate snapping, native search, journey extraction, walking-path reconstruction and kernel serialization. It excludes JavaScript itinerary JSON decoding and final NDJSON encoding/output.',
    coreBoundary: 'Native steady-clock duration around algorithm.run and algorithm.getJourneys. Excludes endpoint snapping, legality checks, walking-path geometry reconstruction and serialization.',
    limitations: [
      'Endpoint-snap rejection reports a zero kernel timer because the search never ran; this is not a zero-cost complete query.',
      'Kernel startup and graph loading precede the adapter timer but delay the first runner response.',
      'This core includes journey extraction and differs from VIGO timetable counters and GraphHopper server timing.',
    ],
  },
  // scripts/r5-engine-adapter.py: raw_r5_routes, route_payload, main.
  R5: {
    adapterBoundary: 'RegionalTask construction, r5py TripPlanner search, native/Python itinerary extraction, table conversion, earliest-arrival selection and response-payload construction. Stops before final JSON encoding/output.',
    coreBoundary: 'No separate native search timer is exported by this adapter.',
    limitations: [
      'R5 here uses the corrected r5py TripPlanner bridge and explicit fixed-departure R5 patch; it is not a direct search-only Java timing.',
      'Python/JVM imports and graph loading precede the adapter timer but delay the first runner response; query-triggered JIT work remains inside.',
      'Native boarding slack remains 60 seconds in this runtime; shared request controls do not establish identical engine semantics.',
    ],
  },
  // scripts/native-engine-adapter.py: otp_query, http_json, query_otp.
  OTP: {
    adapterBoundary: 'GraphQL JSON request encoding and local HTTP request through full response read and JSON decoding. Includes server routing, itinerary construction and serialization; candidate filtering/selection and final NDJSON encoding occur afterward.',
    coreBoundary: 'No native search timer is exported by this adapter.',
    limitations: [
      'GraphQL query-string construction occurs before the declared timer.',
      'JVM startup, graph loading and health checks precede the adapter timer but delay the first runner response; query-triggered JIT work remains inside.',
      'HTTP duration cannot be treated as a search-only core measurement.',
      'The resident adapter reuses its loopback HTTP connection and feed timezone metadata; full response read/decoding remains timed and failed requests are never retried.',
    ],
  },
  // scripts/native-engine-adapter.py: valhalla_query, native_stdout.
  // Installed valhalla/actor.py: Actor.route decorator encodes/decodes dicts.
  Valhalla: {
    adapterBoundary: 'The native_stdout wrapper around Actor.route(options), including stdout redirection, binding request encoding, native routing/itinerary serialization and binding response decoding. Result inspection and final NDJSON encoding occur afterward.',
    coreBoundary: 'No native search timer is exported by this adapter.',
    limitations: [
      'Options are assembled before the timer. Actor construction occurs before the request loop; lazy per-query tile loading may remain inside Actor.route.',
      'The first runner response also waits for Python imports and Actor construction.',
      'The complete binding call is not a search-only core measurement.',
    ],
  },
  // scripts/r5-engine-adapter.py: r5py_routes, route_payload, main.
  R5py: {
    adapterBoundary: 'GeoDataFrame endpoint construction, DetailedItineraries search/materialization, grouping and table-to-record conversion, earliest-arrival selection and response-payload construction. Stops before final JSON encoding/output.',
    coreBoundary: 'No separate native search timer is exported by this adapter.',
    limitations: [
      'Uses the same corrected itinerary bridge and fixed-departure R5 runtime as the R5 entry, with additional GeoPandas/DetailedItineraries work.',
      'Python/JVM imports and graph loading precede the adapter timer but delay the first runner response; query-triggered JIT work remains inside.',
      'Native boarding slack remains 60 seconds in this runtime; shared request controls do not establish identical engine semantics.',
    ],
  },
  // scripts/graphhopper-engine-adapter.py: query, route_url.
  // Pinned GraphHopper 5aec912ef0: PtRouteResource.route, PtRouterImpl.route.
  GraphHopper: {
    adapterBoundary: 'URL construction and local HTTP request through full response read and JSON decoding. Includes server routing, itinerary construction and serialization; adapter path inspection and final NDJSON encoding occur afterward.',
    coreBoundary: 'Optional info.took is a rounded millisecond server-handler timer: request construction, coordinate snapping, routing and itinerary reconstruction, stopping before ResponsePathSerializer JSON construction. It is not search-only core time.',
    limitations: [
      'The info.took boundary is traced to the pinned source; a custom JAR may implement a different boundary.',
      'Server/JVM startup, graph loading and readiness polling precede the adapter timer but delay the first runner response.',
      'The resident adapter reuses its loopback HTTP connection and feed timezone metadata; first metadata access remains inside the request and failed requests are never retried.',
      'Millisecond rounding can make the server counter unsuitable for very small residuals; it is not interchangeable with native search counters.',
    ],
  },
}

export const ENGINE_TIMING_CONTRACTS = Object.freeze(Object.fromEntries(
  Object.entries(contracts).map(([engine, contract]) => [engine, Object.freeze({
    ...contract,
    limitations: Object.freeze(contract.limitations),
  })]),
))
