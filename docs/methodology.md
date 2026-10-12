# Measurement methodology

[Documentation](../README.md) · [Run a benchmark](workflow.md) · [Read the evidence](evidence.md)

The coordinate benchmark measures one selected, complete transit itinerary
between two geographic endpoints. Interpret latency together with route
coverage, feasibility and the exact adapter boundary.

## Workload and population

The default workload is **2,000 coordinate pairs, one submission each**:
1,000 random pairs followed by 1,000 station-pivot pairs. Counts are independently
configurable with `--random-count`, `--near-stop-count`, and
`--station-pivot-count`; a zero count omits that group. Every selected engine
receives the same ordered CSV and departure controls.

| Population | Construction | Interpretation |
| --- | --- | --- |
| `random` | Seeded reservoir sample of coordinate occurrences on OSM highway geometry. | Street-coordinate sampling; neither uniform land-area sampling nor observed travel demand. |
| `near_stop` | Distinct ordered GTFS stop pairs, with both endpoints independently displaced by a random distance and bearing. Default offsets: 0–400 m; default count: 0. | Short access/egress queries; the offset band is a study-design choice, not observed demand. |
| `station_pivot` | Distinct ordered pairs of eligible GTFS stop coordinates, with both endpoints moved independently by a random distance and bearing. Default offsets: 800–1,200 m. | Free-coordinate access/egress queries; engines perform their own snapping. |

Stop anchors exclude parent stations, entrances and invalid coordinates, and
coincident stop coordinates are deduplicated. The station-pivot sampler avoids
repeated anchor pairs and exact coordinate pairs. A finite attempt budget fails
explicitly when it cannot produce the requested population.

Retain `od.csv`, its anchor/offset fields, city-level OD statistics and seed.
The CSV is the authoritative population. Generation metadata records actual
counts and ranges; supplied/reused CSVs retain their type counts. Legacy
`--od-mix` and `--spur-*` flags are rejected with replacement guidance.

Fresh populations are ordered random, station-pivot, then near-stop, preserving
the historical first two groups when adding near-stop rows. Stop-anchor pairs
are unique within each group; groups may share anchors. Offset distance is
uniform in the configured interval and bearing is uniform around the anchor;
this is not uniform-area sampling of an annulus. Exact endpoint-pair duplicates
are rejected when adding stop-derived rows. Endpoints are not pre-snapped or
filtered by engine reachability.

Report `byOdType` timing and outcome summaries separately. A pooled summary
weights groups according to their configured counts. `--base-od-run` appends
new groups to a saved corpus without changing its rows or IDs; its source CSV
is retained separately. `--reuse-run` replays a saved corpus without sampling.

Every engine must prepare the same **one OSM PBF plus every GTFS ZIP** in the
city directory. GTFS-only preparation is ineligible. Unknown native graph
counts remain null; OSM source-coordinate counts are not compiled graph counts.
A fresh build is a fresh output directory, not a flushed operating-system cache.

## Returned routes and timing

The measured product is a selected, fully materialized itinerary: legs, times,
boarding/alighting information and the geometry the engine can return. Raw
itineraries are kept in `queries.ndjson`. Scalar matrix cells and an unexpanded
predecessor handle do not satisfy this lane. Geometry resolution and missing
fields are reported by the quality audit rather than invented by adapters.

Every engine now uses the same caller-side **full-query** timer, from immediately
before request JSON encoding through receipt, JSON decoding, request-ID validation
and observation normalization of its complete response. This includes access/egress
search, transit search, selected-path reconstruction, engine serialization and
IPC. It excludes benchmark evidence writes, progress files and offline audits.
The legacy `wallMs` timer still stops at complete-line receipt for compatibility.

| Saved measurement | Boundary |
| --- | --- |
| `endToEndMs` | Complete caller query including request encoding and response decoding/validation. |
| `wallMs` | Request encoding/send through complete response-line receipt; excludes caller decoding. |
| `queryMs` | Adapter-declared duration; the exact API boundary differs by engine. |
| `requestEncodeMs`, `responseDecodeMs` | Caller request JSON encoding and response decoding/validation/normalization. |
| `adapterOverheadMs` | Paired `endToEndMs - queryMs` for the same request, including everything outside that adapter's timer. |
| `engineQueryMs` | Optional native diagnostic; not a uniform search-only timer across engines. |

Overhead is calculated per observation before summarizing. Missing, negative
or larger-than-end-to-end adapter timers produce a missing residual with an
explicit validity reason; their signed difference is retained for diagnosis.
It is not a comparable measure of pure transport cost: startup, wrapper,
materialization and serialization coverage differ by adapter. Boundary notes
are traced in [the adapter timing contracts](../scripts/benchmark-contracts.mjs).

Summaries retain p50/p95/p99, mean, min/max, sums and timing coverage. New timing
distributions include measured query errors, with `hot.byOutcome` separating
ready, blocked and error responses. Legacy wall/adapter aggregates keep their
previous successful-response/no-itinerary population. `hot.processFirst` singles
out the first process request; `hot.subsequentDistinct` holds subsequent ODs.
Legacy `hot.first` means the first submission of **each OD**, not just startup.
There is no discarded warmup and no repeated route-answer cache lane.

Each engine has one fresh query process and one resident network for the round.
The first request retains lazy opening/startup wait. Process wall time covers
spawn through close, including startup, inter-request evidence/progress work
and shutdown; its amortized cost and throughput remain distinct from per-query
latency. Lane wall time also includes preparation and result bookkeeping.
Completed query evidence is appended immediately, once per response. Dashboard
progress snapshots are coalesced to at most one per 250 ms during fast query
sequences, with immediate first/final/error/phase checkpoints. A force-killed
process may leave a slightly older progress snapshot; retained NDJSON is the
authoritative completed-response evidence.
`--cache-mode disabled` is a request, not proof that every engine exposes or
honors a cache control.

VIGO 0.5 uses the public `stream` command with explicit Route requests and
`diagnostics: trace` for retained journey evidence. The current CLI reports
`timing.computeMs`; this covers the routing call and materialization, while
lazy opening and public response serialization remain in caller wall time.
Compact results use seconds and `meta.computeUs`; the evidence reader converts
these units explicitly and treats `not_found` as a valid blocked outcome.
Missing search counters remain missing.

VIGO-py 0.5 uses `City.route` through `Result.to_json(indent=None)`. Its declared
timer includes wrapper work, runtime communication, lazy query-process opening,
result decoding and serialization. The full runtime command is pinned to the
same Node executable and CLI as the direct VIGO lane. Both interfaces retain
their actual response costs; detailed Python/trace measurements are not compact
HTTP-response benchmarks. `--vigo-python-source` selects the wrapper checkout.

## Comparable controls

The requested policy is earliest arrival at a fixed departure, at least one
transit ride, at most **3 transfers / 4 boardings**, a 240-minute horizon,
4.8 km/h walking, and a 1.2 km budget for each endpoint. Transfer slack is zero
in addition to applicable GTFS rules. `--max-transfers`, `--horizon` and
`--max-walk` make those controls explicit in the saved context.

These are requested controls, not an assertion of identical native semantics:

| Engine | Material differences that must accompany its measurements |
| --- | --- |
| VIGO / VIGO-py | Same Rust routing kernel and public routing policy; free-coordinate connectors are exposed separately from OSM path geometry. Published GTFS transfer times are preserved and may imply a different walking speed. The transit scan horizon can admit a final transfer/egress walk finishing after that horizon. |
| MOTIS | Routed OSM transfers enabled at import and query; timetable values have minute precision. Returned policy violations, including walking distances impossible even allowing one minute of timestamp uncertainty, are explicitly rejected with the native candidate retained. |
| ULTRA-OSM | Bounded endpoint search and boarding limit; selected walks reconstructed on its reduced OSM graph; transit geometry is stop chords. The adapter rejects returned journeys beyond the requested horizon; native horizon pruning is not equivalent. |
| R5 / R5py | Explicit fixed-departure compatibility patch in [Runtime adapters](adapters.md#r5-and-r5py); native boarding slack remains 60 seconds. R5 uses JVM routing via JPype and r5py path extraction, not a pure-Java timing boundary. |
| OTP | Public GraphQL full itinerary request; LIST_ALL bypasses presentation filtering, so the adapter selects the earliest returned candidate passing the transit, transfer, endpoint-walking and horizon checks. Native generalized-cost selection remains its own. |
| Valhalla | Multimodal API uses minute-precision transit times. The adapter rejects returned candidates violating the transit requirement, endpoint walking budgets, transfer cap or horizon, retaining the candidate and rejection reasons. This does not search for a compliant alternative. |
| GraphHopper | A compatibility resource exposes the existing native walking-speed option over HTTP at the common 4.8 km/h; original upstream HTTP default is 5 km/h. The adapter selects the shortest-duration returned candidate passing transit, transfer and horizon checks, retaining rejection diagnostics. Native candidate generation remains its own. |

Do not publish a single cross-engine speed ranking without checking these
boundaries and route feasibility on the same OD subset. A post-query policy
violation remains visible. Adapter policy rejections carry
`outcomeReason: native_candidate_rejected`, `rejectedItinerary`, and explicit
reasons. `blockedBreakdown` separates these from native no-itinerary responses;
neither proves unreachability. Other violations remain audit failures. Successful routes, valid native
no-itinerary outcomes, setup failures, query errors and unsubmitted requests
are separate counts. No-itinerary does not prove an OD is unreachable.

## Memory, storage and cache

| Measurement | Meaning |
| --- | --- |
| `coldPrep.ms` | Wall time for the engine preparation command, including its process lifecycle. |
| `coldPrepRss` | Peak RSS reported for preparation by the platform measurement wrapper. |
| `hotQueryRss` | Peak RSS reported for the resident query process invocation. |
| `peakRss` | Maximum of the available preparation/query RSS values, not their sum. |
| `storage` | Recursive file bytes in the engine working directory, including logs and generated artifacts at measurement time. |
| `round.queryProcessMs` | Query-process lifetime from spawn to close. |
| `lifecycle.elapsedMs` | Whole engine lane through final summary preparation, including setup and bookkeeping. |

RSS uses `/usr/bin/time` (`-l` on macOS, `-v` on other supported Unix systems)
when available. Missing measurements stay null. This is platform-reported RSS,
not a continuous sum of every descendant process's simultaneous memory, and
not the end-of-run RSS used in some separate engineering experiments.
Storage is not restricted to the compiled routing network and excludes
symlinks; source inputs outside the working directory are not counted again.

`--cache-mode native` is the default: every engine may use its own native
caches in one fresh resident query process. `enabled` is a legacy alias for
this policy; neither claims a particular native cache exists. One submission
per OD is not a repeated route-answer-cache experiment. `disabled` remains a
diagnostic request, but adapters do not support equivalent cache disabling;
results from that policy must not be presented as a uniform cache-disabled
ranking. HTTP connections and immutable timezone metadata remain reusable.
VIGO's street-cache diagnostics report its actual acknowledgement and hits.

Engine execution order is deterministically shuffled from the recorded seed,
with the executed order saved. `--engine-order listed` preserves an explicit
order. This reduces a fixed engine-first convention; it does not remove machine
load, OS cache, thermal or order effects. Repeated studies should vary order
and retain every round. First requests are retained and reported separately.

VIGO-py's declared API timer now retains all elapsed `City.route` and result
serialization work, including lazy opening; reported `openMs` is not subtracted.
Complete caller time remains the common metric for every interface. VIGO's
public itinerary includes fare enrichment and decoration: that work is retained
and disclosed, not removed just to improve its score. Other native policy and
output differences remain explicit in the per-engine contracts.

## Reporting a comparison

Use the same OD IDs, controls, output requirements and outcome population for
each paired comparison. Report the number of eligible and measured requests
with every latency distribution. A common-success intersection supports a
paired latency comparison; also show each engine's total ready/blocked/error
counts so that coverage differences remain visible.

The runner uses nearest-rank percentiles. It computes overhead on paired
observations, so subtracting two aggregate medians does not reproduce it.
`meanWarmQueryMs` comes from repeat numbers greater than one: it is normally
null in the formal one-submission workload. Subsequent distinct ODs are not
repeated queries and must not be relabeled as such.

Separate engineering studies measure other products and populations. Native scalar queries, Matrix cells, repeated
alternatives and complete coordinate itineraries need separate tables.

Source: [runner and timing contract](../scripts/run-benchmark.mjs),
[adapter timing boundaries](../scripts/benchmark-contracts.mjs).

## Candidate-budget and paired-subset sensitivity

The main chart measures **end-to-end itinerary interface performance**. R5 and
R5py use patched R5 through Python/r5py; neither lane measures an untouched,
pure-Java native search. Native counters with different boundaries must not be
used to claim an algorithmic speed ratio.

`candidateLimit` in `benchmark.json` (or `--candidate-limit` in the legacy CLI)
requests 1–20 returned candidates from MOTIS, OTP and GraphHopper. The default
remains 1 so existing experiments retain their explicit baseline. Larger limits
are separate experiments: they can change native work, response size and the
ready population. They do not guarantee exhaustive alternative search or that
the engine will return the requested number. Valhalla and the other lanes do not
inherit an unsupported alternative-search control.

Each supported adapter chooses the earliest-arriving or shortest-duration
candidate among returned candidates that pass its adapter checks. Native count,
passing count, selected index and rejection reasons are retained under
`candidateSelection` in query evidence. Rejected candidates remain blocked with
`native_candidate_rejected`; they are not proof that no compliant route exists.
These checks do not prove full journey feasibility or identical native semantics.

For a controlled candidate experiment, reuse a frozen OD set and change only the
candidate budget, writing a new result directory each time:

```bash
npm run bench -- --reuse-run results/run-BASE --engines MOTIS,OTP,GraphHopper --candidate-limit 5
npm run bench -- --reuse-run results/run-BASE --engines MOTIS,OTP,GraphHopper --candidate-limit 10
```

The original sources, date and runtime settings must remain available. Candidate
budget is part of recorded comparison controls and identity, so these executions
must not be merged into one supposedly identical comparison. Repeat with the
same selected engines and matching runtime binaries at budget 1 for the baseline.
All additional native work and serialization remain charged to caller timing.

New `comparison.json` files contain a `sensitivity` section with:

- requested, submitted, unsubmitted, ready coverage, setup errors and outcome reasons;
- common-ready, all-submitted, per-engine ready and excluded-ready distributions;
- p50 ratios with explicit numerator/denominator for each population;
- OD-type, transfer-count, route-duration, response-byte and geometry-presence strata.

All-submission populations include query errors with measured timing. Setup
failures and unsubmitted queries are counted separately and have no invented
latency. Incomplete lanes retain partial distributions, but their ratios are null.
Successful-duration and transfer strata depend on each engine's own answer;
they are descriptive and may have different membership. Missing measurements
remain unreported. Geometry presence is not geometry correctness or completeness;
ULTRA-OSM is explicitly marked as providing simplified geometry.

To analyze existing evidence without changing it:

```bash
node scripts/report-sensitivity.mjs results/run-BASE /path/outside/run/sensitivity.json
```

The command reads the saved run summary and query NDJSON, hashes the source files,
and refuses to overwrite an output or write inside the retained run. It does not
execute engines. It reports historical candidate diagnostics only when recorded;
it cannot reconstruct missing measurements or validate historical binaries.

R5's native 60-second boarding slack remains an explicit unresolved policy
difference. `fairness.json` reports it separately from requested zero additional
slack elsewhere. Compare transfer-sensitive cases with original GTFS rules and
independent itinerary audits before interpreting shorter journeys as better
routing. No unsupported R5 slack override or comparable native Java timer has
been introduced. Quantitative city sensitivity and independent public input/result
packages still require actual licensed inputs and new measured runs.
