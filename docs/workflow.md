# Benchmark workflow

[Documentation](../README.md) · [Methodology](methodology.md) · [Troubleshooting](troubleshooting.md)

Start with retained evidence when the question concerns an existing result.
Create a new run when the question requires a new measurement. The dashboard
and CLI use the same formal coordinate workload.

## Dashboard: benchmark first

Choose **New benchmark**, set its city, size and the three OD-type counts,
then create it. Engines are selected separately each time with the play icon.
An existing benchmark can run repeatedly; stopping a run preserves its
completed observations and generated OD set. The next execution reuses those
coordinates and controls even when the earlier execution has no final summary.
To change the workload size or routing controls, create another benchmark.

**Results** can show one run or combine the latest attempt for each engine.
Each engine row records its execution time. Imported runs are grouped only
when their recorded input, OD and control identity matches. A stopped latest
attempt can have unsubmitted queries; these are not valid no-itinerary results.
Fresh native builds and process-first costs are still measured for every run.

Use **Add city** in the configuration dialog to choose a city name and upload
one OSM PBF plus all relevant GTFS ZIPs. Uploads never overwrite existing files.
File presence allows configuration; successful native import is established
only when the selected engines build their networks.

The map offers one/all ODs and one/all engines. Only successful responses with
native geometry become route overlays. Dotted lines identify coarse segments,
including ULTRA's contracted walking paths and transit stop chords; these do
not establish detailed vehicle or street geometry. Valhalla polyline6 geometry
uses native maneuver indexes, with assumed schedules disclosed separately.

The performance chart places every measured engine on the same axes. Its
shared-routed setting uses the same OD/request IDs across engines; all-response
mode includes valid timed blocked outcomes and query errors. Table summaries
remain full-workload statistics. Neither view establishes identical native
routing semantics or proves itinerary optimality.

## New city: one configuration

```bash
npm run bench -- init my_city
# Add one OSM PBF and all GTFS ZIPs to input/my_city/.
npm run bench -- check my_city
npm run bench -- generate my_city
npm run bench -- run my_city
```

Edit `input/my_city/benchmark.json` for engine names, seed, service date/time,
walking/transfer/horizon controls and all three population counts/ranges.
New configs explicitly use 1,000 pairs in each group. A null service date uses
the common feed date inferred during generation, then retains it for replays.
The configuration rejects unknown keys and invalid values. `init` refuses to
overwrite an existing config. `--input-root PATH` selects another city tree.

`generate` saves an immutable workload directory under `.workloads/` and updates
a separate latest-workload pointer only after successful completion. `run`
automatically generates the first workload; later runs reuse its ODs and controls.
Change the config and call `generate` for a new study. Selecting another engine
subset does not change the population:

```bash
npm run bench -- run my_city --engines VIGO,MOTIS
```

`check` validates input presence, feed metadata, runtime file paths, interpreters
and basic executable availability without a native build. It cannot establish
that a runtime will import successfully or that a route is feasible. Missing
engines are reported, never silently skipped. Native runs retain setup failures,
partial responses and interruption status. No result directory is overwritten.

Each run records input/OD SHA-256 identities, exact requested controls, executed
engine order, selected runtime-file identities, a copy of benchmark scripts,
machine/runtime metadata, native logs, per-request evidence and outcome summaries.
Replaying a new recorded workload fails if source contents or its CSV changed.
Legacy evidence without identities remains readable but cannot provide that check.
Transitive native libraries and OS cache state are not fully captured.

`fairness.json` describes timing and semantic limits. Each city's `comparison.json`
reports complete caller timing on common-ready IDs only when all selected lanes
finish, alongside every lane's outcome counts. A ready reply is not proof of
feasibility or optimality. Native semantics still require the offline route audit.

Advanced flags remain available through `npm run bench -- --cities ...`;
`node scripts/run-benchmark.mjs --help` lists them. `--generate-only` and `--check`
also work directly. Advanced runs retain the legacy 2,000-pair default.

## Browse retained runs

From the repository root:

```bash
npm install
npm run dashboard
```

Open [the local dashboard](http://127.0.0.1:4173), select a run, then inspect a
city, engine and individual query. Complete returned itineraries, outcome counts,
timing coverage and native logs provide the context behind a summary number.
Browsing existing results does not require installing the routing engines.

**Explore ODs** lists the complete saved OD corpus, including blocked, failed
and unsubmitted requests. Search any OD ID, filter by population, page through
the list or use **Previous / Next**. Query timing/outcome filters do not hide
ODs from this browser. Select an engine card to compare the same request; the
map retains the selected OD when switching engines. Missing engines appear as
**Not run**, and observations with different coordinates appear as **OD mismatch**.
Use **Run all engines on these ODs** to create a separate run using the exact
saved CSV and original routing controls. Engine selection remains editable;
the workload controls are locked for this replay.

The map shows saved request endpoints and native itinerary geometry. Solid
blue segments are transit, dashed purple segments are walking, and coarse
geometry is dotted. The public OpenStreetMap basemap requires internet; saved
coordinates and route overlays remain available when tiles cannot load.

The dashboard lists runs recorded with the full-query and overhead timing
contract, including pending and failed runs. Legacy runs are excluded from the
picker; their evidence remains on disk unchanged. The dashboard serves local
assets and binds to loopback. To select a different results disk or port:

```bash
npm run dashboard -- --port 4174 --results-root /Volumes/Bench/results
```

Historical observations may contain only **Transport** timing (`wallMs`).
Missing **Full query** and **Overhead** values remain missing. Neither zero
nor a difference between summary quantiles is a substitute for a measurement.

## Prepare inputs and runtimes

The runner needs Node.js, Python 3, `unzip` for GTFS inspection, and `osmium`
for fresh OSM sampling. Each selected interface also needs its own runtime;
see [Runtime adapters](adapters.md). Building VIGO additionally uses its Rust
toolchain and repository dependencies. There is no one-command installer for
all nine interfaces.

Place one OSM PBF and every relevant GTFS ZIP in each city directory:

```text
input/
└── example_city/
    ├── streets.osm.pbf
    ├── regional_bus.zip
    └── regional_rail.zip
```

City names are directory slugs. Every `.zip` is treated as a GTFS feed, so
unrelated archives do not belong in these directories. The runner records
missing/multiple PBFs and missing feeds as input blockers. `--input-root`
selects another input tree; the default is this repository's `input/`.

Use a date covered by the actual feeds. With no explicit date, the runner
looks for the first common service date across all feeds; this is not
necessarily today or a representative weekday. Inspect the saved
`serviceDate`, `serviceDay` and date source. Explicit dates are requests,
not proof that all feeds provide active service on that date.

For a source-built VIGO runtime, follow the sibling repository's setup first,
then build its native kernel and CLI:

```bash
npm --prefix ../vigo run build:rust-routing-kernel
npm --prefix ../vigo run build:cli
```

## Run one interface first

Replace `example_city` with a prepared directory slug. This command creates a
fresh VIGO network and submits all 2,000 coordinate pairs once:

```bash
npm run bench -- --cities example_city --engine VIGO \
  --count 2000 --repeats 1 --seed 20260816 \
  --time 08:00 --routing-preference fastest --cache-mode native \
  --max-walk 1.2 --max-transfers 3 --horizon 240
```

Add `--service-date YYYY-MM-DD` using the actual service date for the study.
The omitted date in this example invokes feed-calendar inference.
`--engines VIGO,VIGO-py` selects a subset; omitting engine selection runs all
nine configured built-in interfaces. `--cities a,b` selects multiple cities.
An all-engine run can require substantial time, memory and storage.

The CLI defaults to 2,000 pairs and one submission each. Counts are configurable;
repeated queries are rejected in this itinerary lane. Use separate studies
for distinct native/Matrix/repeated-query experiments.

Results go to a new timestamped directory under `results/`. `--output-dir`
changes the parent; `--run-dir` selects a specific new or empty directory.
The runner refuses to overwrite a populated run directory.

Optional `--query-timeout-ms 60000` bounds each response wait and query-process
shutdown. The default is no deadline, including first-request opening. This
does not impose a preparation deadline. A timed-out request is an error;
remaining requests are unsubmitted, not no-itinerary responses.

Run measurements sequentially on a stable machine. Keep builds, test suites
and other benchmark jobs out of the measured interval, and record meaningful
load or sleep interruptions rather than adjusting their timings afterward.

## Customize the three groups

To generate 3,000 pairs per city, with 1,000 in each group:

```bash
npm run bench -- --cities boston --engine VIGO \
  --random-count 1000 --near-stop-count 1000 --station-pivot-count 1000 \
  --near-stop-min-m 0 --near-stop-max-m 400 \
  --station-pivot-min-m 800 --station-pivot-max-m 1200 \
  --seed 20260816 --time 08:00 --routing-preference fastest \
  --cache-mode native --max-walk 1.2 --max-transfers 3 --horizon 240
```

Counts default to 1,000 random, zero near-stop, and 1,000 station-pivot.
Set unwanted groups to zero to run any group alone. `--count`, if supplied for
a fresh population, must match their sum; it does not allocate group counts.
Offset ranges are independent and may overlap; interpret groups using the
saved ranges. Each endpoint's offset is geodesic distance from its anchor,
not a guarantee of an accessible walking path.

To preserve an existing 2,000-pair corpus and append 1,000 near-stop pairs:

```bash
npm run bench -- --cities boston --engine VIGO \
  --base-od-run results/run-PRIOR --near-stop-count 1000 \
  --cache-mode native --max-transfers 3 --horizon 240
```

For extension, random additions are zero and any explicit group-count flag
makes unspecified added groups zero. With no group-count flags, extension
retains the historical behavior of adding 1,000 station-pivot pairs.
Existing rows, IDs and categories remain intact; new rows follow them. Use
`--reuse-run` on the resulting run to replay all 3,000. Sampling flags cannot
be combined with `--reuse-run` or `--od-file`. Original evidence is never overwritten.

## Launch from the dashboard

Use **New benchmark** or **Add test run**. Set **OD pairs per engine** to any
positive integer, or choose 30, 300 or 3,000. **Benchmark types** exposes the
three existing populations: **Random street pairs**, **Near-stop pairs**, and
**Long-offset pairs**. Select one or any combination. Changing the total splits
it as evenly as possible among the selected types. Each card has an editable
count; changing counts updates the total, and zero omits that type. At least one
positive count is required. **Stop-offset distances** adjusts the near-stop
and long-offset distance ranges. The footer shows total requests across engines.
Saved-run badges report the actual type counts in the selected city's CSV.

**Add test run** starts at 30 pairs with an editable size and engine selection.
**Run purpose** distinguishes a test from a benchmark; it does not change the
three population definitions. Test runs use the same preparation and measurement pipeline, retain their run
type and configuration, and save separately under `results/test-*`. Additional
runs can be added after the active run finishes; existing results are preserved.

Choose a city, interfaces and departure controls, then launch. The dashboard
passes **the configured group counts and ranges, one submission, fresh preparation and native caches allowed**
to the CLI. A blank service date uses feed calendars. New runs receive unique
`results/visual-*` directories; launch logs live under `.dashboard-logs/` in
the selected results root.

Only one dashboard-launched run executes at a time. Keep the server running
during measurement. Stop interrupts the process group and retains partial
evidence. It does not convert an interrupted run into a completed result.
The dashboard's single-run guard does not prevent a separately launched CLI
benchmark from competing for resources.

## Reuse an exact population

To measure an engine again without changing a prior run:

```bash
npm run bench -- --cities example_city --engine VIGO-py \
  --reuse-run results/run-PRIOR \
  --routing-preference fastest --cache-mode native \
  --max-transfers 3 --horizon 240
```

Replace `results/run-PRIOR` with a retained compatible run. Reuse reads its
OD CSV and available seed, date/day, time, preference, walk and cache controls.
Explicit flags override inherited values. Transfer and horizon controls are
also inherited from the saved comparison settings. Overrides produce a different
comparison identity; do not combine those results as the same study. Repeats are
always one.

`--od-file path/to/od.csv` supplies coordinates and categories only; set the
date and routing controls separately. A valid CSV uses unique IDs and the categories `random`, `near_stop`, or
`station_pivot`. `--base-od-run` appends stop-derived groups to a retained
population; it creates a new study population, not a same-population rerun. These three source flags
are mutually exclusive.

Reusing ODs does not reuse the prepared network. Keep the original input files
and runtime provenance available, and compare the new `context.json` with the
prior context before combining results. The same seed alone does not establish
the same population when OSM or GTFS inputs change.

## Finish a run

Check the manifest, each engine summary and response counts using
[Read the evidence](evidence.md). Run offline audits in a separate analysis
copy when the evidence is frozen. Manuscript updates belong in a separately
maintained paper workspace.

Source: [runner](../scripts/run-benchmark.mjs),
[dashboard](../scripts/benchmark-dashboard.mjs).
