# Runtime adapters

[Documentation](../README.md) · [Workflow](workflow.md) · [Adapter development](development.md)

A benchmark label identifies an interface and its adapter, not just a routing
algorithm. Record the runtime actually used, its patches, preparation evidence
and response boundary alongside every result.

## Runtime inventory

Paths below are defaults under the repository. CLI flags select explicit
artifacts; a path existing does not prove that its binary matches current source.

| Interface | Runtime / adapter | Path control |
| --- | --- | --- |
| VIGO | Engine 0.5 `vigo/public/vigo.mjs`; public resident `stream` with an explicit query kind and trace evidence. | `--vigo-cli`, `--vigo-kernel` |
| VIGO-py | [Python API adapter](../scripts/python-api-adapter.py), VIGO-py 0.5, and the same selected Node executable, CLI and native addon as VIGO. | `--python`, `--vigo-cli`, `--vigo-kernel`, `--vigo-python-source` |
| MOTIS | `.engine-tools/motis/motis`; local HTTP interface via the [native adapter](../scripts/native-engine-adapter.py). | `--motis-binary` |
| ULTRA-OSM | `.engine-tools/ultra/cmake-build-release2/` binaries and the [ULTRA adapter](../scripts/ultra-engine-adapter.mjs). | `--ultra-checkout`, `--ultra-network`, `--ultra-binary`, `--ultra-kernel`, `--ultra-add-graph` |
| R5 / R5py | Corrected JAR and r5py source via the [R5 adapter](../scripts/r5-engine-adapter.py). | `--python`, `--r5-jar`, `--r5py-source` |
| OTP | `.engine-tools/otp/otp-shaded.jar`; GraphQL via the native adapter. | `--otp-jar` |
| Valhalla | `.engine-tools/valhalla-venv/bin/python` and `.engine-tools/valhalla-resources/timezones.sqlite`. | `--valhalla-python`, `--valhalla-timezones` |
| GraphHopper | `.engine-tools/graphhopper/graphhopper-walk-speed.jar` via the [GraphHopper adapter](../scripts/graphhopper-engine-adapter.py). | `--graphhopper-jar` |

## VIGO 0.5

Build the selected CLI runtime before a future measurement with
`npm --prefix ../vigo run build:cli-runtime`. The harness checks the capability
response for Engine 0.5, the public stream, and trace output before preparing a
City. Both VIGO lanes build fresh Cities; a retained `vigo.city.v1` manifest
alone is insufficient because the prepared indexes changed in 0.5.

Each request carries its service date, clock and routing limits. Workload IDs,
repeat numbers and the caller's complete-duration filter stay in the harness.
VIGO-py receives the same request controls and preserves arrive-by queries;
unsupported wrapper options fail explicitly. Its default source is the sibling
`vigo-py` checkout; `VIGO_BENCH_PYTHON_SOURCE` remains an environment override.

Provenance hashes the selected CLI, Node executable, native addon and Python
package sources. Engine capability output and the Python preparation record
identify their reported versions and commands. A source path or version string
alone does not establish that a binary was rebuilt.

Historical private runners and their saved results are not included.

## Setup scope

The setup command covers **R5, GraphHopper and ULTRA-OSM**. It does not install
all nine interfaces or their complete prerequisites. Select a subset explicitly:

```bash
npm run setup:expanded-engines -- --help
npm run setup:expanded-engines -- --engines GraphHopper
npm run setup:expanded-engines -- --engines R5,ULTRA-OSM
```

GraphHopper setup needs Git, Java and Maven. It fetches the pinned source
revision `5aec912ef0c4572f5d504f623cdec7b06d16daf9`, refuses a modified pinned
checkout, and builds the web JAR. The PT lane uses `gtfs.trip_based=false`.
R5 setup needs r5py 1.0.7 and the original JAR already present at
`.engine-tools/r5/r5-v7.4-r5py-all.jar`. ULTRA setup needs an existing source
checkout and C++23/OpenMP; its builder uses Homebrew LLVM/libomp on macOS.
Setup writes generated runtime artifacts under ignored `.engine-tools/`.
Retain a separately selected runtime snapshot for a frozen study before
rebuilding its default artifacts.

## R5 and R5py

The pinned R5 v7.4-r5py sampler can throw or loop indefinitely for sub-minute
windows. The explicit compatibility build adds one departure sample when
`fromTime == toTime` and rejects zero-step random sampling. Native street
routing, McRAPTOR rounds and boarding slack are unchanged. A native factory
creates the same dominance lists without invoking Python for every state bag.
For zero tolerance, an index replaces repeated pairwise dominance scans while
preserving accepted states and their order. The build checks the optimized list
against the upstream implementation before installing the JAR.
Both R5 lanes require this marked JAR and report the patch in their results.
The source JAR is preserved.

```bash
python3 scripts/build-r5-fixed-departure.py \
  .engine-tools/r5/r5-v7.4-r5py-all.jar \
  .engine-tools/r5/r5-v7.4-r5py-itineraries.jar
```

Both interfaces use `.engine-tools/r5/r5py-earliest`, a local corrected copy
of r5py 1.0.7 installed by `npm run setup:expanded-engines -- --engines R5`.
Use `--r5py-source` to select a separately retained copy. It selects
the earliest native candidate at each departure, disables the extra suboptimal
path window, and removes the minute added to reconstructed walking-leg clocks.
Waiting fields are computed from consecutive reconstructed leg timestamps.
Transfer paths use the native linked street vertices and minimum-distance
objective. Reconstructed distances must match the compiled transfer table;
walking clocks use the same distance-to-time calculation as the transit search.
Endpoint search reads native state costs and constructs geometry only for the
selected legs. A resident network reuses its coordinate transformer. The R5
point-query adapter omits unused matrix linkage, and DetailedItineraries caps
worker count at its actual OD count.
The installed package is preserved; `itinerary.patch` records every source change.
This does not change R5's native transfer model or certify original-GTFS feasibility.

## ULTRA-OSM

ULTRA's GTFS merge adapter strips surrounding spaces from stop latitude and
longitude for its strict numeric parser; source archives are unchanged. Native
preprocessing failures propagate through the terminal launcher. The upstream
`Network` degree-two reducer assumes symmetric arcs and can crash or change
distances on a directed walking graph. The [directed-reduction patch](../scripts/patches/ultra-directed-reduction.patch)
replaces that step with directed vertex elimination: preserve stops, compose
only existing incoming/outgoing paths, and keep the shorter cost independently
in each direction. The setup command validates and compiles the patched source into
`Network-directed`, which is the runner default. The upstream checkout is
preserved. `--ultra-network` selects a separately retained build. The
[reducer test](../test/ultra_directed_reduction.cpp) enumerates all four-vertex directed
graphs with three weight patterns and one or two removable vertices, checking
all retained stop-pair distances against an independent all-pairs calculation.

## GraphHopper

The [walking-speed compatibility builder](../scripts/build-graphhopper-walk-speed.py)
exposes the existing `Request.setWalkSpeedKmH` through `pt.walk_speed`. It compiles
the HTTP resource against the pinned JAR, preserves the source checkout and
original JAR, and retains patched source in `graphhopper-walk-speed.jar`.
Setup installs both artifacts; the adapter requires the compatibility marker
so an unpatched runtime cannot silently ignore the common 4.8 km/h request.
Walk-only, over-transfer and over-horizon candidates are retained as explicit
policy rejections, separate from native no-itinerary outcomes.

GraphHopper's default Java heap limit is 10 GiB, matching the completed NYC
recovery. `VIGO_GRAPHHOPPER_HEAP_GB` overrides the limit; preparation metadata
records it. Initial allocation remains 256 MiB. Build-time
memory failures remain setup errors, and connection resets during startup
retain the native exit diagnostic. They are not no-itinerary responses.

## MOTIS

Query servers use a free loopback port, configured through a temporary data
view. Imported graphs and their original configuration remain unchanged.
Native HTTP/protocol failures remain errors; recognized no-route responses
remain blocked. Recoverable request errors retain their IDs and allow remaining
requests to continue while the native server is alive.

## OTP

OTP builds freeze `transitServiceStart` and `transitServiceEnd` to the original
feed calendars and requested date. Its default period is relative to build
day and can otherwise discard a historical benchmark's entire service day.

## Evidence carried by an adapter

Each interface must load every city GTFS ZIP and the city OSM PBF. Compatibility
copies and patches belong to the engine's private build, with source inputs
preserved. Keep the original runtime, corrected artifact, patch, import logs
and preparation metadata traceable; a successful setup is not route validation.

The runner saves native stdout/stderr and preparation details. Its timing
boundary descriptions are [source-based contracts](../scripts/benchmark-contracts.mjs),
not proof that an older retained binary implements today's adapter. Check the
saved command, runtime snapshot and query fields before interpreting history.

For native policy differences, see [Comparable controls](methodology.md#comparable-controls).
For protocol and validation, see [Adapter development](development.md).

## Returned-candidate sensitivity

MOTIS, OTP and GraphHopper accept the benchmark `candidateLimit` control
(default 1, maximum 20). Increasing it requests more native candidates in one
call; there are no hidden retry requests. The adapter chooses a compliant
candidate from those actually returned and retains selection diagnostics.
Other interfaces have no new candidate-budget override. See
[candidate-budget and subset sensitivity](methodology.md#candidate-budget-and-paired-subset-sensitivity)
for the exact experiment scope and the separate R5 boarding-slack limitation.
