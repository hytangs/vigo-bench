# Troubleshooting

[Documentation](../README.md) · [Workflow](workflow.md) · [Evidence](evidence.md)

Start with the failing layer and its saved evidence. Keep the original run
intact; diagnose or retry in a new directory.

| Symptom | Inspect | Next step |
| --- | --- | --- |
| City missing from the catalog | `--input-root`, city directory name, input validation. | Supply exactly one PBF and at least one GTFS ZIP in that directory. |
| Engine summary is `blocked`, with no queries | `blockedReason`, runtime paths and city input errors. | Resolve setup/configuration first; do not count these as no-itinerary responses. |
| Preparation fails | `prepare.stderr`, `prepare.stdout`, `coldPrep`, `setupErrors`. | Preserve the native error and fix that runtime/import problem. |
| R5 artifact/patch marker missing | Corrected JAR, r5py source path and [setup prerequisites](adapters.md#setup-scope). | Prepare the corrected pair or select a retained compatible pair explicitly. |
| GraphHopper startup connection reset | Native exit diagnostic and preparation log. | Check startup failure and heap demand; changing heap does not change the outcome category. |
| Historical OTP date returns no service | Original GTFS calendars and saved OTP build service period. | Verify the build includes the requested date; today's build-relative period is not sufficient. |
| First response appears stalled | `progress.json`, query log, process state and runtime loading. | Allow for startup/opening, or use an explicit query deadline on a new run. |
| Mismatched ID or invalid adapter JSON | `query.stderr`, observation `error` and captured `raw` excerpt. | Keep stdout for one response per line and echo each request ID exactly. |
| Many valid `blocked` responses | Date, transit requirement, endpoint access, horizon and native diagnostics. | Diagnose the common inputs and constraints; do not infer global unreachability. |
| Run is interrupted | Manifest, engine progress and complete NDJSON lines. | Report retained responses and unsubmitted requests separately; keep the partial run. |
| Full-query/overhead column is empty | Per-query fields and timing coverage. | Use retained Transport timing if available; do not reconstruct missing measurements. |
| Overhead is invalid | `adapterTimingSource`, `adapterOverheadStatus`, signed delta. | Check adapter boundary, units and native rounding; preserve invalid values as diagnostic evidence. |
| `meanWarmQueryMs` is null | Repetition count. | Expected for the formal one-submission workload; subsequent distinct ODs are a different group. |
| Audit cannot find inputs | Absolute OSM/GTFS paths in `context.json`. | Restore access to the exact retained inputs; a similarly named updated feed is not equivalent. |
| Quality comparison rejects the run | City count, unique OD IDs, coordinates, categories and audit files. | Use a single-city analysis copy with matching OD identity and schedule-audit outputs. |
| Explicit run directory is rejected | Whether it already contains files. | Choose a new directory; do not empty a retained run to reuse its name. |

## Completion looks better than the underlying results

The CLI can finish its orchestration while some interfaces have setup blockers
or query errors. A city `complete` label can coexist with unsuccessful engine
lanes. Read every engine's counts, `unsubmittedQueries`, `round.complete`,
process exit status and error list; see [outcome accounting](evidence.md#separate-outcomes-from-execution-state).

## A rerun changed routes

Compare OD files, feed contents, dates and controls first, then exact runtime,
adapter and patch versions. Keep both results and the mismatching itineraries.
Differences can come from native policy, input updates, normalization defects
or a routing change. Diagnose the owning engine or wrapper
instead of rewriting a baseline or hiding the difference in the harness.

## A measurement is unexpectedly fast or slow

Check the timer boundary, outcome population, response materialization,
process-first sample, cache controls and competing host work. A quick no-route
response and a complete materialized itinerary are different outcomes. An
isolated native timer cannot explain the complete query without the surrounding
access, opening, wrapper and serialization measurements.

Runtime-specific details: [R5/R5py](adapters.md#r5-and-r5py),
[ULTRA](adapters.md#ultra-osm), [GraphHopper](adapters.md#graphhopper),
[OTP](adapters.md#otp).
