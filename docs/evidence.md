# Read the evidence

[Documentation](../README.md) · [Methodology](methodology.md) · [Troubleshooting](troubleshooting.md)

A retained run is a chain from input files and request controls to engine
responses, audits and reported numbers. Read that chain before interpreting
a fast query or a complete-looking table.

## Run layout

```text
results/run-…/
├── run-manifest.json
├── summary.json
└── example_city/
    ├── od.csv
    ├── context.json
    ├── summary.json
    └── vigo/
        ├── progress.json
        ├── summary.json
        ├── prepare.stdout
        ├── prepare.stderr
        ├── query.stderr
        ├── queries.ndjson
        └── network/
```

Engine directories use lowercase names with hyphens (`vigo-py`, `ultra-osm`).
Network artifact names vary by adapter. Older runs may lack manifests,
progress records or newer timing fields. Setup blockers can have a summary
without a query file; an interrupted run can have response lines without a
final top-level summary.

| Artifact | Use it to establish |
| --- | --- |
| `run-manifest.json` | Requested interfaces/cities, controls, live phase, completed lane count and recorded issues. |
| City `context.json` | OSM/GTFS paths, date/time, routing controls, OD statistics and expected request count. |
| `od.csv` | Exact coordinates, OD identity, category and available anchor/offset provenance. |
| Engine `summary.json` | Preparation outcome, setup/query errors, counts, timing coverage, resources and process completion. |
| `queries.ndjson` | Per-request outcome, complete returned itinerary, timing fields and diagnostics. |
| Native logs | Build/runtime failures and warnings behind an adapter result. |
| Offline audit files | Checks actually performed and unresolved or unverifiable fields. |

The runner appends observations during querying and saves completed engine
summaries immediately. Progress files update as observations arrive; terminal
progress is reported on the first, every 250th and final response. The reader
can expose complete lines in an interrupted NDJSON file and flags a partial
last line rather than inventing a response.

## Separate outcomes from execution state

| State | What it means | What it does not establish |
| --- | --- | --- |
| Query `ready` | The adapter returned an itinerary. | Feasibility, legality, global optimality or satisfaction of every requested policy. |
| Query `blocked` | The native interface returned a no-itinerary outcome. | Proof that no feasible journey exists. |
| Query `error` | A submitted request failed, including protocol errors or a deadline. | A legitimate no-route result. |
| Setup blocked | Inputs/runtime/configuration were unavailable before querying. | Any routing outcome. |
| Setup error | Preparation failed or did not provide required graph evidence. | A query failure rate. |
| Unsubmitted | No observation was retained for that requested query. | Zero latency or a blocked route. |

`status` depends on its level. An engine summary's `blocked` can mean missing
configuration; a query's `blocked` means no itinerary. Read `blockedReason`,
`coldPrep`, `setupErrors`, `queryProcess`, `counts` and `unsubmittedQueries`
together. Engine-level `ready` means the execution completed without recorded
lane errors; it does not mean every query returned a route. Likewise, a city
summary can say `complete` when only one engine lane completed successfully.

For the formal lane, reconcile each engine against 2,000 requested queries:

```text
ready + blocked + errors + unsubmittedQueries = 2000
```

Also inspect `round.complete`, the process exit/timeout and `errors` array.
A manifest can finish with `complete_with_issues`; the runner exiting normally
does not imply every interface succeeded. A timed-out request can contribute
latency to the error population while later requests remain unsubmitted.

## Read a timing result

1. Identify the exact field and boundary: full query, legacy transport,
   adapter-declared, optional native diagnostic, preparation or process time.
2. Identify the population: all observations, ready only, blocked only,
   process-first, subsequent distinct ODs or repeated ODs.
3. Check `samples`, `eligible`, `missing`, `invalid` and `coverage`.
4. Check matching OD IDs, requested controls, native differences and route
   quality before calculating a cross-engine ratio.

Use [Methodology](methodology.md) for field definitions. Historical missing
values remain null; neither current source nor a later run can supply a
measurement that an older run never recorded.

## Audit returned itineraries

The schedule audit checks active services, boarding/alighting times,
pickup/drop-off permissions and published unscoped transfer minima against
the original GTFS. It also checks chronology, transfers, walking budgets and
speed, horizon, endpoint/leg continuity and geometry availability. Each OD
retains issues and fields that cannot be verified.

**The audit commands write files into the supplied run.** For frozen evidence,
prepare a separate analysis copy of the run's summaries, contexts and query
files, preserving its city/engine layout and access to the original inputs.
Use that copy below; running an audit again overwrites its prior audit outputs.

```bash
python3 scripts/audit-itineraries.py results/analysis-copy
python3 scripts/audit-osm-walks.py results/analysis-copy
```

The first writes engine `quality.ndjson` and top-level `quality-summary.json`.
The second writes engine `osm-quality.ndjson` and city `osm-quality-summary.json`;
it requires `osmium`, `pyproj` and Shapely. It checks walking geometry against
OSM highway corridors with a 3 m buffer and records missing geometry and
unmatched/restricted-way proximity. It is a geometric check, not a topology or
legal-access oracle: barriers, conditional access, snap connectors and unmapped
station paths require separate interpretation.

A returned itinerary that violates policy stays a returned itinerary with an
audit issue. It is not silently reclassified as no route. A better arrival from
another engine is a witness to investigate, not a global optimum certificate.

## Compare route quality

For a **single-city** run with schedule-audit files:

```bash
python3 scripts/compare-route-quality.py results/analysis-copy \
  --output results/agreement-NEW
```

Choose a new output directory and retain the analysis script/version with its
reports. The comparison needs NumPy. OSM audit files are optional inputs;
their absence must remain visible in the interpretation.

The primary comparison fixes the common-success intersection across VIGO,
R5, MOTIS and OTP, then compares arrival, an externally defined generalized
duration, walking and transfers. It retains pairwise disagreements, coverage,
OD-stratified bootstrap intervals, weight sensitivity and reference-exclusion
checks. Wrapper interfaces are excluded from the independent reference
baseline. Engine agreement alone establishes neither legality nor optimality.

## Carry evidence into a report

Keep the input population, controls, engine/runtime identity, measurement
boundary, timing coverage, outcome counts, resource boundary and audit limits
beside each reported comparison. Distinguish retained results from new runs,
synthetic regressions from city workloads, and projections from completed
measurements. Freeze the source and native artifacts used for a study before
later changes make the working checkout diverge from the measured version.

Private inputs, raw routes, runtime snapshots and unpublished comparisons stay
in ignored local directories or a separate private evidence store. Public claims
need reproducible public evidence. Paper updates belong in a separate workspace.

Sources: [runner](../scripts/run-benchmark.mjs),
[schedule audit](../scripts/audit-itineraries.py),
[OSM audit](../scripts/audit-osm-walks.py),
[quality comparison](../scripts/compare-route-quality.py).
