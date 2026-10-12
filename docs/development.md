# Adapter development

VIGO 0.5 adapter checks can run without preparing or querying a City:

```bash
PYTHONDONTWRITEBYTECODE=1 node --test test/benchmark.test.mjs test/timing.test.mjs test/vigo-interface.test.mjs test/vigo-adapter-integration.test.mjs test/study.test.mjs
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=test python3 -m unittest test_python_api_timing
```

These tests use synthetic responses, temporary files and mock child processes.
They check schema/unit conversion, request controls, response identity, timing
boundaries and runtime provenance. They produce no City performance evidence.
The optional integration check uses the selected sibling VIGO-py source with a
simulated CLI; it does not load a native engine or import GTFS/OSM data.

[Documentation](../README.md) · [Runtime adapters](adapters.md) · [Methodology](methodology.md)

Adapters translate one shared coordinate workload into each native interface
and return its complete result with explicit timing and limitations. Engine
behavior belongs in the engine repository; wrapper behavior belongs in the
wrapper. Keep the benchmark's translation, measurement and audit code here.

## Source map

| File | Responsibility |
| --- | --- |
| [benchmark-study.mjs](../scripts/benchmark-study.mjs) | New-city configuration and check/generate/run workflow. |
| [benchmark-recording.mjs](../scripts/benchmark-recording.mjs) | Input identities, benchmark source snapshots and selected runtime provenance. |
| [benchmark-fairness.mjs](../scripts/benchmark-fairness.mjs) | Explicit comparison policy and common-ready descriptive summaries. |
| [run-benchmark.mjs](../scripts/run-benchmark.mjs) | Inputs, OD generation, controls, preparation/query processes and outcome normalization. |
| [benchmark-statistics.mjs](../scripts/benchmark-statistics.mjs) | Pure outcome/timing summaries; one sort per distribution and bounded argument usage. |
| [benchmark-evidence.mjs](../scripts/benchmark-evidence.mjs) | Atomic metadata writes and coalesced dashboard checkpoints. |
| [adapter_runtime.py](../scripts/adapter_runtime.py) | Resident loopback HTTP, immutable feed metadata and streaming GTFS readers. |
| [benchmark-contracts.mjs](../scripts/benchmark-contracts.mjs) | Per-interface timing boundaries and limitations. |
| [benchmark-data.mjs](../scripts/benchmark-data.mjs) | Retained evidence discovery and reading, including incomplete runs. |
| [benchmark-dashboard.mjs](../scripts/benchmark-dashboard.mjs) | Local dashboard, city uploads and execution orchestration. |
| [benchmark-library.mjs](../scripts/benchmark-library.mjs) | Reusable benchmark definitions, execution history and stopped-workload replay. |
| [comparison-chart.js](../dashboard/comparison-chart.js) | Shared engine latency chart and paired OD selection. |
| [native-engine-adapter.py](../scripts/native-engine-adapter.py) | MOTIS, OTP and Valhalla interfaces. |
| [python-api-adapter.py](../scripts/python-api-adapter.py) | VIGO-py public API and serialized results. |
| [r5-engine-adapter.py](../scripts/r5-engine-adapter.py) | R5 and R5py, including corrected itinerary extraction. |
| [ultra-engine-adapter.mjs](../scripts/ultra-engine-adapter.mjs) | ULTRA import, resident kernel and itinerary response. |
| [graphhopper-engine-adapter.py](../scripts/graphhopper-engine-adapter.py) | GraphHopper import, HTTP readiness and queries. |

## Register a private adapter

Create ignored `engine-config.json` in the repository root, or pass its path
with `--engine-config`. Use argument arrays to preserve paths containing
spaces; command strings are split on whitespace, not parsed by a shell.

```json
{
  "engines": {
    "Example": {
      "loads": ["osm", "gtfs"],
      "prepare": ["python3", "/absolute/path/example-adapter.py"],
      "query": ["python3", "/absolute/path/example-adapter.py"]
    }
  }
}
```

Select it with `--engine Example`. `command` can replace both phase keys when
the adapter branches on `VIGO_BENCH_PHASE`. Use a distinct name for a new
interface: built-in engine dispatch has its own commands. The dashboard
launch UI lists the built-in nine; use the CLI for a configured custom name.

## Preparation phase

Both phases inherit the environment and run from the engine working directory.
Read the saved context for the authoritative workload controls.

| Environment variable | Contents |
| --- | --- |
| `VIGO_BENCH_PHASE` | `prepare` or `query`. |
| `VIGO_BENCH_ENGINE`, `VIGO_BENCH_CITY` | Engine label and city slug. |
| `VIGO_BENCH_CONTEXT` | Path to the city's `context.json`. |
| `VIGO_BENCH_OSM_PBF` | Original OSM PBF path. |
| `VIGO_BENCH_GTFS_PATHS_JSON` | JSON array of all original GTFS ZIP paths. |
| `VIGO_BENCH_GTFS_COUNT` | Number of GTFS inputs. |
| `VIGO_BENCH_OD_CSV` | Exact coordinate workload. |
| `VIGO_BENCH_WORKDIR`, `VIGO_BENCH_NETWORK_DIR` | Engine output directory and its `network/` path. |
| `VIGO_BENCH_SERVICE_DATE`, `VIGO_BENCH_SERVICE_DAY`, `VIGO_BENCH_TIME` | Requested service date, day class and departure time. |
| `VIGO_BENCH_ROUTING_PREFERENCE`, `VIGO_BENCH_MAX_WALK_KM` | Routing preference and endpoint access budget. |
| `VIGO_BENCH_COMPARISON` | JSON controls including transit requirement, transfer/horizon limits and walking speed. |

Preparation builds from **both** OSM and every GTFS feed, exits nonzero on
failure, and prints one JSON object to stdout. Put logs on stderr. Include
native graph counts under `network.street` (`nodes`, `edges`, `source`) and
`network.transit` (`stops`, `trips`, and other exposed counts), together with
input/import evidence and runtime metadata. `networkSize` is also accepted.

Unexposed graph counts should be null with an explicit source/import
description, never copied from OSM geometry counts and labeled as compiled
nodes. The runner checks for usable street/import evidence and positive
transit stop/trip counts; that structural check does not prove the adapter
loaded every input correctly. Retain native logs and verify ingestion.

## Resident query phase

Load the prepared network once. Read one JSON request per stdin line and
write exactly one JSON response per line, in request order. Echo the exact
request `id`; flush each response, and send diagnostics to stderr. The runner
submits sequentially and validates IDs. Banners on stdout are protocol errors.

An illustrative request, with synthetic coordinates:

```json
{
  "id": "od_0001_run_1",
  "odId": "od_0001",
  "repeat": 1,
  "origin": {"coordinate": [-77.0, 38.9]},
  "destination": {"coordinate": [-77.01, 38.91]},
  "disableCache": true,
  "requireTransitRide": true,
  "maxTransfers": 3,
  "horizonMinutes": 240
}
```

Coordinates use **longitude, latitude**. The service date, time, endpoint
budget and remaining common controls are in the context/environment.

Response fields:

| Field | Contract |
| --- | --- |
| `id` | Exact matching request identifier. |
| `status` | `ready`, `blocked` or `error`. |
| `queryMs` | Adapter-declared milliseconds, with the actual timing boundary documented. Missing measurements remain null. |
| `itinerary` | Fully materialized native itinerary for a ready result, including available legs, times, boarding/alighting fields and geometry. |
| `timing` | Optional measured diagnostics, such as native timers; preserve units and meaning. |
| `detail` / `error` / `failure` | Native no-itinerary reason, exception or diagnostic code as applicable. |

A no-itinerary response can be `{"id":"od_0001_run_1","status":"blocked",
"queryMs":2.4,"detail":"No itinerary returned"}`. This is an illustrative
protocol value, not a measured result. Return errors for crashes, bad requests
and protocol failures; do not turn them into blocked routes. A scalar duration
or opaque predecessor handle does not satisfy the complete-itinerary lane.

Native itinerary schemas differ. Add explicit normalization to the offline
audit when extending its engine set; the generic runner accepting a response
does not mean that the schedule/geometry audit understands it. Never fabricate
missing geometry or infer feasibility from a `ready` label.

## Timing and tests

Declare the adapter timer around the work it actually measures. The runner
owns complete caller timing and the paired residual; do not subtract startup
or serialization selectively without retaining and documenting that boundary.
Update [timing contracts](../scripts/benchmark-contracts.mjs) for built-in
adapter changes, and preserve provenance when a runtime patch affects results.

Install `requirements.txt` in an activated Python virtual environment, then run
the repository's existing tests from its root:

```bash
npm test
```

This runs Node harness/dashboard/timing tests and Python adapter/audit tests.
Some Python comparison tests require NumPy. Protocol fixtures and mocks test
accounting and translation; they are not live-engine performance or route
quality evidence. For focused work, examples are:

```bash
node --test test/timing.test.mjs
python3 -m unittest discover -s test -p 'test_adapter_outcomes.py'
```

A new adapter needs focused checks for setup failure, valid no itinerary,
query errors, missing timing, response identity, complete itinerary retention
and the native controls it claims to support. Measure live routing separately
on matched inputs after the implementation is ready.

## Performance diagnostics

`node scripts/profile-harness.mjs --output /new/path/harness.json` measures a
synthetic 3,000-response protocol/evidence lane and summary computation. It
checks persisted observation parity and records content digests, with three
lane trials and five summary trials. `--runner PATH` can point at an isolated
source snapshot for a before/after comparison. Output files must be new.

`python3 scripts/profile-adapter-overhead.py --feed /path/to/feed.zip --output /new/path/adapters.json`
compares uncached/cached feed timezone reads, fresh/resident loopback HTTP,
and materialized/streamed GTFS row counting. `--feed PATH` selects your input. HTTP is a controlled server fixture with
TCP_NODELAY, not a native routing server. Python traced allocation is not RSS.

Neither command prepares or queries native routing engines. Keep these records
separate from formal benchmark runs. These synthetic diagnostics do not establish
city routing performance.
