#!/usr/bin/env python3
"""Paired, offline route comparison from retained itineraries and quality audits."""
from __future__ import annotations

import argparse
from collections import Counter
import csv
import importlib.util
from itertools import combinations, product
import json
import math
from pathlib import Path
import shutil

import numpy as np

spec = importlib.util.spec_from_file_location('itinerary_audit', Path(__file__).with_name('audit-itineraries.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

PRIMARY = ('VIGO', 'R5', 'MOTIS', 'OTP')
METRICS = ('arrival_minutes', 'generalized_minutes', 'walking_meters', 'transfers')
TOLERANCES = {'arrival_minutes': (2 / 60, 1, 5, 10), 'generalized_minutes': (1, 5, 10),
              'walking_meters': (50, 100, 500), 'transfers': (0, 1)}


def generalized(row, walking_weight=2, waiting_weight=2, transfer_penalty=5):
    return (row['ride_minutes'] + walking_weight * row['walking_minutes']
            + waiting_weight * row['waiting_minutes'] + transfer_penalty * row['transfers'])


def route_metrics(engine, row, schedule, departure, *, missing_distance_ok=False):
    if row['status'] != 'ready' or not isinstance(row.get('itinerary'), dict):
        return None
    legs = audit.normalize(engine, row['itinerary'], schedule)
    moving = [leg for leg in legs if leg['mode'] != 'wait']
    rides = [leg for leg in moving if leg['mode'] == 'ride']
    if not rides:
        return None
    if any(leg['start'] is None or leg['end'] is None for leg in moving):
        raise ValueError('missing leg times')
    if any(not math.isfinite(leg[k]) for leg in moving for k in ['start', 'end']):
        raise ValueError('non-finite leg times')
    if any(leg['end'] < leg['start'] - 2 for leg in moving):
        raise ValueError('negative moving duration')
    walking = [leg for leg in moving if leg['mode'] == 'walk']
    distances = [leg.get('distanceM') if leg.get('distanceM') is not None
                 else audit.line_length(leg['coordinates']) for leg in walking]
    if any(value is not None and (not math.isfinite(value) or value < 0) for value in distances):
        raise ValueError('invalid walking distance')
    if any(value is None for value in distances) and not missing_distance_ok:
        raise ValueError('missing or invalid walking distance')
    arrival = max(leg['end'] for leg in moving)
    walk_time = sum(max(0, leg['end'] - leg['start']) for leg in walking) / 60
    ride_time = sum(max(0, leg['end'] - leg['start']) for leg in rides) / 60
    elapsed = (arrival - departure) / 60
    waiting = elapsed - walk_time - ride_time
    if waiting < -2 / 60:
        raise ValueError('moving durations exceed elapsed duration')
    # Explicit through-service flags avoid treating remaining seated as a transfer.
    interlining = sum(bool(leg.get('interlineWithPreviousLeg')) for leg in rides)
    if interlining >= len(rides):
        raise ValueError('invalid interlining count')
    result = dict(arrival_seconds=arrival, arrival_minutes=elapsed,
                  walking_meters=None if None in distances else sum(distances),
                  walking_minutes=walk_time, ride_minutes=ride_time, waiting_minutes=max(0, waiting),
                  initial_wait_minutes=max(0, (moving[0]['start'] - departure) / 60),
                  transfers=max(0, len(rides) - 1 - interlining), ride_legs=len(rides),
                  interlined_legs=interlining, time_precision_seconds=max(leg.get('timePrecisionSeconds', 1) for leg in moving),
                  walking_distance_source='missing' if None in distances else
                  'geometry' if any(leg.get('distanceM') is None for leg in walking) else 'native')
    result['generalized_minutes'] = generalized(result)
    return result


def quantile(values, probability, weights=None):
    if not len(values):
        return None
    if weights is None:
        return float(np.quantile(values, probability, method='inverted_cdf'))
    order = np.argsort(values)
    cumulative = np.cumsum(np.asarray(weights)[order])
    position = min(len(order) - 1, np.searchsorted(cumulative, probability * cumulative[-1]))
    return float(np.asarray(values)[order[position]])


def disagreement(values, metric):
    values = np.asarray(values, dtype=float)
    if not len(values):
        return {'n': 0}
    absolute = np.abs(values)
    output = dict(n=len(values), signed_mean=float(values.mean()), signed_median=quantile(values, .5),
                  signed_p025=quantile(values, .025), signed_p975=quantile(values, .975),
                  mae=float(absolute.mean()), rmse=float(np.sqrt(np.mean(values ** 2))),
                  absolute_p50=quantile(absolute, .5), absolute_p90=quantile(absolute, .9),
                  absolute_p95=quantile(absolute, .95), absolute_p99=quantile(absolute, .99),
                  absolute_max=float(absolute.max()))
    for tolerance in TOLERANCES[metric]:
        output[f'within_{tolerance:g}'] = float(np.mean(absolute <= tolerance + 1e-9))
        output[f'a_lower_{tolerance:g}'] = float(np.mean(values < -tolerance - 1e-9))
        output[f'a_higher_{tolerance:g}'] = float(np.mean(values > tolerance + 1e-9))
    return output


def common_ids(data, engines, eligible=None):
    shared = set.intersection(*(set(data[engine]) for engine in engines))
    return sorted(od for od in shared if eligible is None or all(eligible(engine, od) for engine in engines))


def relative_disagreement(values):
    """Rows are ODs; column zero is VIGO, the others are independent references."""
    values = np.asarray(values, dtype=float)
    if values.ndim != 2 or values.shape[1] < 3:
        raise ValueError('At least two independent references are required')
    vigo = np.abs(values[:, [0]] - values[:, 1:])
    reference = np.column_stack([np.abs(values[:, a] - values[:, b]) for a, b in combinations(range(1, values.shape[1]), 2)])
    return vigo, reference


def bootstrap_indices(types, resamples, seed):
    rng = np.random.default_rng(seed)
    groups = [np.flatnonzero(np.asarray(types) == kind) for kind in sorted(set(types))]
    return np.concatenate([rng.choice(group, size=(resamples, len(group))) for group in groups], axis=1)


def relative_summary(values, indices, weights=None):
    vigo, reference = relative_disagreement(values)
    a, b = vigo.mean(axis=1), reference.mean(axis=1)
    delta = a - b
    weights = np.ones(len(values)) / len(values) if weights is None else np.asarray(weights) / np.sum(weights)
    resampled_delta = (delta[indices] * weights[indices]).sum(axis=1)
    low, high = np.quantile(resampled_delta, [.025, .975])
    amean, bmean = float(a @ weights), float(b @ weights)
    return dict(n=len(values), vigo_to_reference_mae=amean, reference_to_reference_mae=bmean,
                mae_ratio=amean / bmean if bmean else None,
                mean_excess=float(delta @ weights), excess_ci_low=float(low), excess_ci_high=float(high),
                upper_ci_below_zero=bool(high < 0),
                vigo_absolute_p95=quantile(vigo.ravel(), .95, np.repeat(weights, vigo.shape[1])),
                reference_absolute_p95=quantile(reference.ravel(), .95, np.repeat(weights, reference.shape[1])),
                vigo_absolute_p99=quantile(vigo.ravel(), .99, np.repeat(weights, vigo.shape[1])),
                reference_absolute_p99=quantile(reference.ravel(), .99, np.repeat(weights, reference.shape[1])))


def read_ndjson(path):
    with path.open() as stream:
        for line in stream:
            yield json.loads(line)


def write_csv(path, rows):
    if not rows:
        path.write_text('')
        return
    fields = list(dict.fromkeys(key for row in rows for key in row))
    with path.open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fields)
        writer.writeheader()
        writer.writerows(rows)


def write_report(output):
    """Render only the saved scalar analysis; this function never opens an engine."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    summary = json.loads((output / 'summary.json').read_text())
    if not summary['common_cohorts']['common_success']['n']:
        lines = [f"# {summary['city'].title()}: paired route-quality agreement", '',
                 'The VIGO/R5/MOTIS/OTP common-success cohort is empty. The three-reference '
                 'relative disagreement is undefined; it is not zero agreement or an engine-quality ranking.', '',
                 '| Engine | Native ready | Native blocked | Native errors | Complete transit metrics |',
                 '| --- | ---: | ---: | ---: | ---: |']
        for engine, value in summary['coverage'].items():
            counts = value['native_statuses']
            lines.append(f"| {engine} | {counts.get('ready', 0)} | {counts.get('blocked', 0)} | "
                         f"{counts.get('error', 0)} | {value['transit_metrics']} |")
        lines += ['', 'All available engine pairs remain in pairwise-comparison.csv and coverage.csv. '
                  'Their pairwise-success OD subsets can differ and must not be substituted for the fixed '
                  'four-engine cohort. Raw itineraries, outcomes and benchmark timings are unchanged.', '']
        (output / 'REPORT.md').write_text('\n'.join(lines))
        return
    with (output / 'pairwise-comparison.csv').open() as stream:
        pairs = list(csv.DictReader(stream))
    with (output / 'paired-differences.csv').open() as stream:
        deltas = list(csv.DictReader(stream))
    with (output / 'coverage.csv').open() as stream:
        coverage = list(csv.DictReader(stream))
    outliers = json.loads((output / 'arrival-outliers.json').read_text())
    relative = [r for r in summary['relative_disagreement'] if r['cohort'] == 'common_success']
    names = {'arrival_minutes': 'Arrival / elapsed time (min)', 'generalized_minutes': 'Generalized duration (min)',
             'walking_meters': 'Walking distance (m)', 'transfers': 'Transfers'}
    def num(value, digits=3):
        return 'n/a' if value is None or value == '' else f'{float(value):.{digits}f}'
    def percent(value):
        return num(100 * float(value), 1) + '%'
    def ci(row):
        return f"[{num(row['excess_ci_low'])}, {num(row['excess_ci_high'])}]"
    total = summary['common_cohorts']['common_success']['n']
    split = summary['common_cohorts']['common_success']['od_types']
    lines = [f"# {summary['city'].title()}: paired route-quality agreement", '',
             f"Four independent engine lanes have {summary['common_native_ready']} native common-success ODs. "
             f"The fixed complete-metric intersection contains **{total} ODs**: {split.get('random', 0)} random and "
             f"{split.get('station_pivot', 0)} station-pivot. Every primary engine pair below uses these same ODs. "
             "VIGO-py and R5py are excluded from the independent reference baseline; their supplementary comparisons remain in the CSV.", '',
             f"Service date {summary['service_date']}, fixed request time {summary['time']}. This analysis is offline and leaves "
             "raw routes, timings and all running benchmark jobs unchanged. It tests agreement between native outputs, not true error against an optimal or observed itinerary.", '',
             '## Relative disagreement on exactly the same ODs', '',
             'For each OD, A is the mean absolute VIGO–R5/MOTIS/OTP difference; B is the mean absolute difference across '
             'R5–MOTIS, R5–OTP and MOTIS–OTP. The reported comparison is mean(A − B). Negative values mean VIGO differs '
             'less from the three references than they differ from one another, on this metric and cohort.', '',
             '| Metric | VIGO ↔ references MAE | References ↔ references MAE | Ratio | Mean excess, 95% interval |',
             '| --- | ---: | ---: | ---: | --- |']
    for row in relative:
        lines.append(f"| {names[row['metric']]} | {num(row['vigo_to_reference_mae'])} | {num(row['reference_to_reference_mae'])} | "
                     f"{num(row['mae_ratio'])} | {num(row['mean_excess'])} {ci(row)} |")
    lines += ['', f"Intervals jointly resample ODs, stratified by OD type, with {summary['bootstrap']['resamples']:,} draws "
              f"and seed {summary['bootstrap']['seed']}. "
              'The three differences from one OD are never treated as independent observations. These are pointwise exploratory '
              'intervals, not a simultaneous four-metric equivalence test. ODs can share transit services and street links; '
              'the intervals are not adjusted for spatial/network clustering and do not quantify uncertainty across other cities or dates.', '',
              '## Pairwise disagreement distributions', '',
              'Positive signed differences mean the first engine returns a higher value. At the shared departure time, '
              'arrival differences equal elapsed-duration differences. Elapsed duration includes the initial wait, even when '
              'OTP or MOTIS moves the itinerary departure later than 08:00.', '',
              '| Pair | Arrival bias min | Arrival MAE min | Absolute p50 / p95 min | Within 1 / 5 / 10 min | G MAE min | Walk MAE m | Exact transfers |',
              '| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |']
    lookup = {(r['engine_a'], r['engine_b'], r['metric']): r for r in pairs if r['cohort'] == 'common_success'}
    for a, b in combinations(PRIMARY, 2):
        if (a, b, 'arrival_minutes') not in lookup:
            continue
        arrival, score, walk, transfers = [lookup[a, b, key] for key in METRICS]
        lines.append(f"| {a} ↔ {b} | {num(arrival.get('signed_mean'))} | {num(arrival.get('mae'))} | "
                     f"{num(arrival.get('absolute_p50'))} / {num(arrival.get('absolute_p95'))} | "
                     + ' / '.join(percent(arrival[f'within_{t}']) for t in [1, 5, 10])
                     + f" | {num(score['mae'])} | {num(walk['mae'], 1)} | {percent(transfers['within_0'])} |")
    lines += ['', 'The retained CSV additionally reports signed 2.5th/97.5th percentiles, RMSE, absolute p90/p99/max, '
              'directional exceedance rates, walking thresholds of 50/100/500 m, and differences of zero or one transfer. '
              'It contains pairwise-only common-success subsets for all nine API lanes; those changing OD subsets are supplementary and never used in the primary reference-baseline calculation.', '',
              f"![Absolute disagreement distributions]({output.resolve() / 'disagreement-ecdf.png'})", '',
              '| Metric | VIGO-reference absolute p95 / p99 | Reference-reference absolute p95 / p99 |',
              '| --- | ---: | ---: |']
    for row in relative:
        lines.append(f"| {names[row['metric']]} | {num(row['vigo_absolute_p95'])} / {num(row['vigo_absolute_p99'])} | "
                     f"{num(row['reference_absolute_p95'])} / {num(row['reference_absolute_p99'])} |")
    lines += ['', 'The time axes are linear up to one minute and logarithmic above it; the walking axis changes at 50 metres. '
              'These tails pool three pairwise differences per OD with equal OD weights. They are descriptive '
              'distributions, not independent replicates. A smaller mean disagreement does not establish that every quantile '
              'or every pair is closer. In particular, inspect generalized-duration p99 separately.', '',
              '## Common generalized duration', '',
              '**G = ride minutes + 2 × walk minutes + 2 × wait minutes + 5 × transfers.** This is one common, '
              'illustrative external score, not estimated traveller preferences or any engine’s native generalized cost. '
              'Waiting is elapsed duration minus moving walk and ride time; it includes initial waiting and unallocated boarding/dwell slack. '
              'Walking includes access, transfers and egress. No route is reselected to optimize G.', '',
              'The full sensitivity grid uses walking weights 1/1.5/2, waiting weights 1/2, and transfer penalties 0/5/10 minutes. '
              'The unweighted/no-penalty case recovers elapsed duration. Native cost controls can differ: '
              '[OTP documents waiting multipliers and boarding/transfer costs](https://docs.opentripplanner.org/en/latest/RouteRequest/).', '']
    for cohort in ['common_success', 'common_policy_checked']:
        rows = [r for r in summary['generalized_sensitivity'] if r['cohort'] == cohort]
        lines.append(f"- {cohort}: mean excess below zero in {sum(r['mean_excess'] < 0 for r in rows)}/{len(rows)} weight combinations; "
                     f"95% upper limit below zero in {sum(r['upper_ci_below_zero'] for r in rows)}/{len(rows)} combinations.")
    lines += ['', '## Subgroups and robustness', '',
              '| Cohort | Metric | N | MAE ratio | Mean excess, 95% interval |',
              '| --- | --- | ---: | ---: | --- |']
    for row in summary['relative_disagreement']:
        if row['cohort'] != 'common_success':
            lines.append(f"| {row['cohort']} | {names[row['metric']]} | {row['n']} | {num(row['mae_ratio'])} | {num(row['mean_excess'])} {ci(row)} |")
    lines += ['', 'The common-success population is conditional on all four engines succeeding and is dominated by station-pivot ODs. '
              'A pooled result must not be presented as a result for every random OD or for the original 50:50 input population. '
              'The following additional exploratory checks give equal total weight to the two OD types and remove each reference in turn; '
              'their estimates still use the same complete-metric OD list.', '',
              '| Robustness check | Metric | MAE ratio | Mean excess, 95% interval |',
              '| --- | --- | ---: | --- |']
    for row in summary['robustness']:
        lines.append(f"| {row['analysis']} | {names[row['metric']]} | {num(row['mae_ratio'])} | {num(row['mean_excess'])} {ci(row)} |")
    lines += ['', '## Coverage, missing metrics and legality', '',
              '| Engine | Native ready | Native no itinerary | Complete transit metrics |',
              '| --- | ---: | ---: | ---: |']
    for engine, value in summary['coverage'].items():
        lines.append(f"| {engine} | {value['native_statuses'].get('ready', 0)} | {value['native_statuses'].get('blocked', 0)} | {value['transit_metrics']} |")
    lines += ['', 'No-itinerary is retained as a separate native outcome, not proved unreachable. Complete transit metrics '
              'exclude pure walking and incomplete distance/time outputs. Missing walking distance is not imputed from walking time or a straight line. '
              f"There are {len(summary['extraction_errors'])} incomplete-metric records listed in summary.json. "
              "The time-based sensitivity includes common native-success records that have usable times but lack walking distances:", '',
              '| Available-time metric | N | MAE ratio | Mean excess, 95% interval |',
              '| --- | ---: | ---: | --- |']
    for row in summary['available_time_sensitivity']:
        lines.append(f"| {names[row['metric']]} | {row['n']} | {num(row['mae_ratio'])} | {num(row['mean_excess'])} {ci(row)} |")
    lines += ['', '| Pair | Complete transit in both | First only | Second only | Neither |',
              '| --- | ---: | ---: | ---: | ---: |']
    for row in coverage:
        if row['engine_a'] in PRIMARY and row['engine_b'] in PRIMARY:
            lines.append(f"| {row['engine_a']} ↔ {row['engine_b']} | {row['common_transit_metrics']} | {row['a_only']} | {row['b_only']} | {row['neither']} |")
    lines += ['', 'Timetable/policy sensitivity requires every ride to match the original active GTFS, no detected chronology '
              'violation and no detected common walking/transfer/horizon-policy violation. It does not require each engine to '
              'supply identical geometry. MOTIS timetable precision is one minute; the other primary outputs have finer precision. '
              'R5 retains its native 60-second boarding slack. Distinct snapping, station links, walk costs and candidate selection remain.', '',
              '| Engine, main common cohort | Timetable/policy passes | Geometry-gap flags | OSM corridor matches |',
              '| --- | ---: | ---: | ---: |']
    for engine, row in summary['common_cohort_audit'].items():
        lines.append(f"| {engine} | {row['policy_passes']} | {row['geometry_issues']} | {row['osm_corridor_matches']} |")
    consensus = [r for r in outliers if r['reference_range'] <= 1]
    lines += ['', '## Disagreement cases retained for review', '',
              f"The three references arrive within one minute of one another on {len(consensus)} common ODs. "
              f"VIGO is more than one minute later than their latest arrival on {sum(r['vigo_later_than_latest_reference'] > 1 for r in consensus)}, "
              f"and more than one minute earlier than their earliest arrival on {sum(r['vigo_earlier_than_earliest_reference'] > 1 for r in consensus)}. "
              'Earlier is not automatically correct: unusually early or late outputs both need a feasible-path explanation.', '',
              '| OD | VIGO min | R5 min | MOTIS min | OTP min | VIGO mean disagreement minus reference mean disagreement, min |',
              '| --- | ---: | ---: | ---: | ---: | ---: |']
    for row in outliers[:10]:
        lines.append(f"| {row['odId']} | " + ' | '.join(num(row['arrival_minutes'][e]) for e in PRIMARY)
                     + f" | {num(row['excess_difference'])} |")
    lines += ['', 'arrival-outliers.json retains every main-cohort OD with signed directions, reference spread and the prior '
              'per-engine audit issues. It is a review list, not a finding that any specific engine is wrong.', '',
              '## Interpretation and reproduction', '',
              'This supports an explicitly scoped statement about observed cross-engine agreement when its metric-specific '
              'interval is below zero. It does not establish global optimality, legal street access, equality of all distributions, '
              'or interchangeability of the engines. The reference engines are not ground truth and can share modelling errors. '
              'The distinction between agreement and correlation follows the paired-difference approach of '
              '[Bland and Altman](https://doi.org/10.1016/S0140-6736(86)90837-8); the relative three-reference baseline is defined here.', '',
              'Raw response sources, metrics and bootstrap settings are listed in summary.json. '
              'compare-route-quality.py and audit-itineraries.py are copied alongside this report. Run the comparison script '
              'with the retained single-city run and an output directory; it writes CSVs, JSON, this report and a standalone PDF/PNG figure. '
              'No engine rerouting or benchmark timing is performed.', '']
    (output / 'REPORT.md').write_text('\n'.join(lines))

    with plt.rc_context({'font.family': 'DejaVu Sans', 'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False}):
        fig, axes = plt.subplots(2, 2, figsize=(11, 8), constrained_layout=True)
        for ax, metric in zip(axes.flat, METRICS):
            for is_vigo, label, color, style in [(True, 'VIGO ↔ R5/MOTIS/OTP', '#007f86', '-'),
                                               (False, 'Reference ↔ reference', '#b45125', '--')]:
                values = np.sort([abs(float(r[metric])) for r in deltas if (r['engine_a'] == 'VIGO') == is_vigo])
                ax.step(values, np.arange(1, len(values) + 1) / len(values), where='post', label=label, color=color, linestyle=style, lw=2)
            ax.set_xlabel('Absolute difference: ' + names[metric])
            ax.set_ylabel('Cumulative share of pairwise differences')
            ax.set_ylim(0, 1.02)
            ax.grid(alpha=.2)
            if metric == 'transfers':
                ax.set_xticks([0, 1, 2, 3])
                ax.set_xlim(-.05, 3.1)
            else:
                ax.set_xscale('symlog', linthresh=50 if metric == 'walking_meters' else 1)
                ticks = [0, 50, 100, 500, 1000, 3000] if metric == 'walking_meters' else [0, 1, 5, 10, 30, 100]
                ax.set_xticks(ticks, labels=[str(t) for t in ticks])
                ax.set_xlim(left=0)
        axes[0, 0].legend(loc='lower right', fontsize=9)
        fig.suptitle(f"{summary['city'].title()} · {total} identical common-success ODs\n"
                     'Three pairs per OD in each distribution; initial waiting included', fontsize=13)
        fig.supxlabel('Time/distance axes: linear near zero, logarithmic beyond 1 minute / 50 metres', fontsize=9)
        fig.savefig(output / 'disagreement-ecdf.png', dpi=180)
        fig.savefig(output / 'disagreement-ecdf.pdf')
        plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--resamples', type=int, default=2000)
    parser.add_argument('--seed', type=int, default=20260907)
    args = parser.parse_args()
    if args.resamples < 100:
        parser.error('--resamples must be at least 100')
    summary = json.loads((args.run / 'summary.json').read_text())
    if len(summary['cities']) != 1:
        parser.error('Pass a single-city retained run to keep each population explicit.')
    city = summary['cities'][0]
    directory = args.run / city['citySlug']
    context = json.loads((directory / 'context.json').read_text())
    schedule = audit.Schedule(context['gtfs'], context['serviceDate'])
    h, m = map(int, context['time'].split(':'))
    departure = 3600 * h + 60 * m
    data, quality, osm, statuses, types, coordinates = {}, {}, {}, {}, {}, {}
    extraction_errors, sources, partial = [], {}, {}
    for entry in city['engines']:
        engine = entry['engine']
        folder = directory / engine.lower()
        source = folder / 'queries.ndjson'
        if not source.exists():
            continue
        sources[engine] = str(source.resolve())
        data[engine], statuses[engine], partial[engine] = {}, {}, {}
        quality[engine] = {r['odId']: r for r in read_ndjson(folder / 'quality.ndjson')}
        osm[engine] = {r['odId']: r for r in read_ndjson(folder / 'osm-quality.ndjson')} if (folder / 'osm-quality.ndjson').exists() else {}
        for row in read_ndjson(source):
            od = row['odId']
            if od in statuses[engine]:
                raise ValueError(f'Duplicate OD in {engine}: {od}')
            pair = [row['origin']['coordinate'], row['destination']['coordinate']]
            if od in coordinates and coordinates[od] != pair:
                raise ValueError(f'Coordinates differ for {engine}: {od}')
            coordinates[od] = pair
            if od in types and types[od] != row['odType']:
                raise ValueError(f'OD type differs for {engine}: {od}')
            types[od] = row['odType']
            statuses[engine][od] = row['status']
            try:
                metrics = route_metrics(engine, row, schedule, departure)
                if metrics:
                    data[engine][od] = metrics
            except (ValueError, KeyError, TypeError, IndexError) as error:
                extraction_errors.append(dict(engine=engine, odId=od, error=str(error)))
                try:
                    metrics = route_metrics(engine, row, schedule, departure, missing_distance_ok=True)
                    if metrics:
                        partial[engine][od] = metrics
                except (ValueError, KeyError, TypeError, IndexError):
                    pass
    if not all(engine in data for engine in PRIMARY):
        raise ValueError('Primary independent engines are missing')
    if len({tuple(sorted(statuses[e])) for e in PRIMARY}) != 1:
        raise ValueError('Primary engine OD populations differ')
    args.output.mkdir(parents=True, exist_ok=True)
    write_csv(args.output / 'route-metrics.csv', [dict(engine=e, odId=od, odType=types[od], **r) for e in data for od, r in data[e].items()])
    write_csv(args.output / 'partial-route-metrics.csv', [dict(engine=e, odId=od, odType=types[od], **r) for e in partial for od, r in partial[e].items()])
    success_rows = [dict(odId=od, odType=types[od], **{e: statuses[e].get(od, 'unsubmitted') for e in statuses}) for od in sorted(types)]
    write_csv(args.output / 'success-by-od.csv', success_rows)

    def policy_checked(engine, od):
        q = quality[engine][od]
        return (q.get('boardings', 0) > 0 and q.get('scheduledRidesVerified') == q.get('rideLegs', q.get('boardings'))
                and not q.get('feasibilityIssues') and not q.get('commonPolicyIssues'))

    primary_ids = common_ids(data, PRIMARY)
    cohorts = {'common_success': primary_ids,
               'common_policy_checked': common_ids(data, PRIMARY, policy_checked),
               'common_random': [od for od in primary_ids if types[od] == 'random'],
               'common_station_pivot': [od for od in primary_ids if types[od] == 'station_pivot']}
    pairwise, differences, relative, sensitivity, outliers, robustness = [], [], [], [], [], []
    for cohort, ids in cohorts.items():
        for a, b in combinations(PRIMARY, 2):
            for metric in METRICS:
                delta = [data[a][od][metric] - data[b][od][metric] for od in ids]
                pairwise.append(dict(cohort=cohort, engine_a=a, engine_b=b, metric=metric, **disagreement(delta, metric)))
            if cohort == 'common_success':
                differences.extend(dict(odId=od, odType=types[od], engine_a=a, engine_b=b,
                                        **{metric: data[a][od][metric] - data[b][od][metric] for metric in METRICS}) for od in ids)
        if not ids:
            continue
        indices = bootstrap_indices([types[od] for od in ids], args.resamples, args.seed)
        for metric in METRICS:
            values = np.array([[data[e][od][metric] for e in PRIMARY] for od in ids])
            relative.append(dict(cohort=cohort, metric=metric, **relative_summary(values, indices)))
            if cohort == 'common_success':
                counts = Counter(types[od] for od in ids)
                weights = [1 / (len(counts) * counts[types[od]]) for od in ids]
                robustness.append(dict(analysis='equal_OD_type_weights', metric=metric,
                                       **relative_summary(values, indices, weights)))
                for excluded in PRIMARY[1:]:
                    chosen = [i for i, engine in enumerate(PRIMARY) if engine != excluded]
                    robustness.append(dict(analysis=f'exclude_reference_{excluded}', metric=metric,
                                           **relative_summary(values[:, chosen], indices)))
        if cohort in {'common_success', 'common_policy_checked'}:
            for w, q, penalty in product([1, 1.5, 2], [1, 2], [0, 5, 10]):
                values = np.array([[generalized(data[e][od], w, q, penalty) for e in PRIMARY] for od in ids])
                sensitivity.append(dict(cohort=cohort, walking_weight=w, waiting_weight=q, transfer_penalty=penalty,
                                        **relative_summary(values, indices)))

    coverage = []
    for a, b in combinations(data, 2):
        shared = common_ids(data, (a, b))
        all_od = set(statuses[a]) | set(statuses[b])
        coverage.append(dict(engine_a=a, engine_b=b, submitted_union=len(all_od), common_transit_metrics=len(shared),
                             a_only=len(set(data[a]) - set(data[b])), b_only=len(set(data[b]) - set(data[a])),
                             neither=len(all_od - (set(data[a]) | set(data[b])))))
        for metric in METRICS:
            pairwise.append(dict(cohort='pairwise_success', engine_a=a, engine_b=b, metric=metric,
                                 **disagreement([data[a][od][metric] - data[b][od][metric] for od in shared], metric)))
    for od in primary_ids:
        values = np.array([data[e][od]['arrival_minutes'] for e in PRIMARY])
        vigo, peers = relative_disagreement(values[None, :])
        outliers.append(dict(odId=od, odType=types[od], arrival_minutes={e: data[e][od]['arrival_minutes'] for e in PRIMARY},
                             mean_absolute_vigo_difference=float(vigo.mean()), mean_absolute_peer_difference=float(peers.mean()),
                             excess_difference=float(vigo.mean() - peers.mean()), reference_range=float(np.ptp(values[1:])),
                             vigo_later_than_latest_reference=float(values[0] - max(values[1:])),
                             vigo_earlier_than_earliest_reference=float(min(values[1:]) - values[0]),
                             checks={e: {k: quality[e][od].get(k) for k in ['commonPolicyIssues', 'feasibilityIssues', 'geometryIssues', 'unknown']} for e in PRIMARY}))
    for name, rows in [('pairwise-comparison.csv', pairwise), ('paired-differences.csv', differences),
                       ('relative-disagreement.csv', relative), ('generalized-sensitivity.csv', sensitivity),
                       ('robustness.csv', robustness), ('coverage.csv', coverage)]:
        write_csv(args.output / name, rows)
    available = {e: dict(data[e], **partial[e]) for e in PRIMARY}
    partial_ids = common_ids(available, PRIMARY)
    available_time_sensitivity = []
    if partial_ids:
        partial_indices = bootstrap_indices([types[od] for od in partial_ids], args.resamples, args.seed)
        available_time_sensitivity = [dict(metric=metric, **relative_summary(
            np.array([[available[e][od][metric] for e in PRIMARY] for od in partial_ids]), partial_indices))
            for metric in ['arrival_minutes', 'generalized_minutes', 'transfers']]
    patterns = Counter(''.join('1' if od in data[e] else '0' for e in PRIMARY) for od in sorted(types))
    output = dict(city=city['citySlug'], service_date=context['serviceDate'], time=context['time'], primary_engines=PRIMARY,
                  reference_engines=PRIMARY[1:], source_run=str(args.run.resolve()), sources=sources,
                  generalized_score={'ride_weight': 1, 'walking_weight': 2, 'waiting_weight': 2, 'transfer_penalty_minutes': 5},
                  bootstrap={'resamples': args.resamples, 'seed': args.seed, 'unit': 'OD jointly across engines, stratified by OD type',
                             'interval': '95% pointwise percentile; exploratory, not geographic-cluster adjusted'},
                  coverage={e: dict(native_statuses=dict(Counter(statuses[e].values())), transit_metrics=len(data[e])) for e in data},
                  common_cohorts={name: dict(n=len(ids), od_types=dict(Counter(types[od] for od in ids))) for name, ids in cohorts.items()},
                  common_native_ready=sum(all(statuses[e][od] == 'ready' for e in PRIMARY) for od in statuses[PRIMARY[0]]),
                  primary_success_patterns=dict(patterns), extraction_errors=extraction_errors,
                  relative_disagreement=relative, generalized_sensitivity=sensitivity, robustness=robustness,
                  available_time_sensitivity=available_time_sensitivity,
                  common_cohort_audit={e: dict(policy_passes=sum(policy_checked(e, od) for od in primary_ids),
                                              geometry_issues=sum(bool(quality[e][od].get('geometryIssues')) for od in primary_ids),
                                              osm_corridor_matches=sum(osm[e].get(od, {}).get('status') == 'corridor_match' for od in primary_ids),
                                              interlined_legs=sum(data[e][od]['interlined_legs'] for od in primary_ids)) for e in PRIMARY})
    (args.output / 'summary.json').write_text(json.dumps(output, indent=2) + '\n')
    (args.output / 'common-od-ids.json').write_text(json.dumps(cohorts, indent=2) + '\n')
    (args.output / 'arrival-outliers.json').write_text(json.dumps(sorted(outliers, key=lambda r: r['excess_difference'], reverse=True), indent=2) + '\n')
    for source in [Path(__file__), Path(__file__).with_name('audit-itineraries.py')]:
        destination = args.output / source.name
        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)
    write_report(args.output)
    print(json.dumps({'output': str(args.output), 'cohorts': output['common_cohorts'],
                      'extractionErrors': len(extraction_errors), 'primaryRelative': relative[:4]}, indent=2))


if __name__ == '__main__':
    main()
