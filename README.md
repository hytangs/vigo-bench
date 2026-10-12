# VIGO Bench

A local coordinate-routing benchmark harness for the VIGO routing family and other routing engines.

This repository contains source, adapters, documentation and synthetic tests.
It includes no city inputs, retained benchmark results, private paper drafts or
prebuilt engine binaries. Supply your own licensed inputs and runtimes.
Node.js 22 or newer and Python 3.10 or newer are required for the harness and tests;
individual engines have additional requirements described in the adapter guide.

VIGO Bench sends the same coordinate workload to **VIGO, VIGO-py, MOTIS,
ULTRA-OSM, R5, OTP, Valhalla, R5py and GraphHopper**, retaining preparation
logs, complete returned itineraries, timings, resources and route audits.
Start with a result, inspect the journey behind it, then follow its evidence.

## Start here

| I want to… | Guide |
| --- | --- |
| Browse a retained result or launch a new run | [Benchmark workflow](docs/workflow.md) |
| Understand the workload, timers and comparable controls | [Measurement methodology](docs/methodology.md) |
| Read outcomes, inspect routes and audit a comparison | [Read the evidence](docs/evidence.md) |
| Prepare an engine or understand its compatibility patches | [Runtime adapters](docs/adapters.md) |
| Add an adapter or work on the harness | [Adapter development](docs/development.md) |
| Diagnose a blocked, incomplete or surprising run | [Troubleshooting](docs/troubleshooting.md) |

## Open the dashboard

From this repository:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci --ignore-scripts
npm run dashboard
```

The live dashboard is included in this repository and runs locally; GitHub does
not host it as a running service. It shows live preparation/query progress and
supports starting, stopping and replaying runs.

Open [127.0.0.1:4173](http://127.0.0.1:4173). Create a benchmark by choosing a
city, OD count, and any mix of random street, near-stop, and long-offset pairs.
Use **Add city** to upload one OSM PBF and one or more GTFS ZIPs. Inputs and
results stay local; native engine setup validates their routing compatibility.

A benchmark is one reusable OD set. The **play** icon opens engine selection;
**stop** interrupts execution, and **refresh** reloads results. Run it again
with any engines. Existing OD bytes and routing controls are reused, including
from interrupted runs. Results shows either one execution or the latest result
for each engine. Older evidence is never overwritten.

Search any OD and compare engine responses. The map can overlay one OD or all
ODs, for one engine or every engine. Overlays use engine colors; walking is
dashed and coarse geometry dotted. ULTRA's contracted walking geometry and
stop-to-stop transit lines are identified as simplified. Valhalla's native
assumed-schedule markers are exposed in route details. Missing geometry stays
missing. Public OpenStreetMap basemap tiles require internet access.

The shared performance chart compares full query latency on the same routed
ODs by default. Switch to all responses to include blocked outcomes and errors.
Timing layers remain separate; historical missing measurements stay missing.
Existing results need no routing-engine installation. New execution needs the
inputs and runtimes described in the [workflow](docs/workflow.md).

## Add a city and run

```bash
npm run bench -- init my_city
```

Put **one OSM PBF and all relevant GTFS ZIPs** in `input/my_city/`.
Edit `input/my_city/benchmark.json` to choose engines, date/time, routing
controls and population. New city configs explicitly request 1,000 random,
1,000 near-stop and 1,000 long-offset pairs.

```bash
npm run bench -- check my_city
npm run bench -- generate my_city
npm run bench -- run my_city
```

`run` generates a workload if none exists, then reuses that exact saved corpus.
For a subset: `npm run bench -- run my_city --engines VIGO,MOTIS`.
Each execution builds fresh networks and writes a new result directory.
Changed study settings or source contents require a new `generate`; previous
workloads and results remain intact.

Normal runs allow each engine's native caches, submit each OD once, and compare
complete caller timing. No VIGO-only timing subtraction or favorable query
selection is used. `fairness.json` records interface differences, including
VIGO's extra fare work; this is not a claim of identical native search tasks.
See [workflow and advanced controls](docs/workflow.md) and
[measurement methodology](docs/methodology.md). Existing `npm run bench -- --cities ...`
commands still work; their legacy default population remains 2,000 pairs.

## Follow the evidence

```text
OSM + all GTFS feeds → saved OD population and controls → fresh preparation
                   → resident queries → retained responses → offline audits
```

Results live under `results/`. Keep successful itineraries, native no-itinerary
outcomes, setup failures, query errors and unsubmitted requests separate.
Report full-query, adapter, native, process and preparation timing at their
actual boundaries. Route agreement is evidence to investigate, not a proof of
street legality or global optimality.

[Read the evidence](docs/evidence.md) explains the directory layout, completion
states, timing coverage and offline checks. Audit commands write derived
files; use a separate analysis copy when working with frozen evidence.

## Fairness sensitivity

Use `candidateLimit` to investigate returned-candidate selection and the automatic
`comparison.json` sensitivity section to compare common-success timing with
coverage, all submissions, route complexity and output size. The dashboard’s
**Coverage and subset sensitivity** table shows shared-ready and all-submitted
timing beside coverage and recorded candidate rejections. Existing evidence
can be analyzed read-only with `node scripts/report-sensitivity.mjs RUN NEW_OUTPUT.json`.
See [candidate and subset sensitivity](docs/methodology.md#candidate-budget-and-paired-subset-sensitivity)
for experiment controls, limitations and interpretation.

## Related projects and publication scope

- [VIGO](https://github.com/hytangs/vigo): routing engine and CLI/server.
- [VIGO-py](https://github.com/hytangs/vigo-py): Python API and wheels.
- VIGO Bench: workload generation, adapters, local dashboard and measurement methods.

Inputs, results, runtime downloads and local configuration are ignored by Git.
Keep credentials, licensed inputs and unpublished comparisons outside published
source. Historical private studies and manuscript workflows are not included.
Synthetic tests establish harness behavior; they do not establish city routing
accuracy or performance. Publish comparison claims only with reproducible,
redistributable evidence and the measurement boundaries described in the guides.

Run `npm test` for harness and adapter regressions. See
[Adapter development](docs/development.md) for what those tests establish.
