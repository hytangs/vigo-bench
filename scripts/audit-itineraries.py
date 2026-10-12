#!/usr/bin/env python3
"""Audit retained full-route evidence. Never queries an engine or changes raw results.

Schedule checks use the original GTFS ZIPs, not any engine's imported timetable.
A passed check establishes the checks listed here, not global route optimality.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import csv
import datetime as dt
import io
import json
import math
from pathlib import Path
import zipfile
from zoneinfo import ZoneInfo


def distance(a, b):
    if not a or not b:
        return None
    rad = math.pi / 180
    x = math.sin((b[1] - a[1]) * rad / 2) ** 2 + math.cos(a[1] * rad) * math.cos(b[1] * rad) * math.sin((b[0] - a[0]) * rad / 2) ** 2
    return 12742000 * math.asin(min(1, math.sqrt(x)))


def line_length(points):
    return sum(distance(a, b) for a, b in zip(points, points[1:])) if points else None


def decode_polyline(value, precision=5):
    if not value:
        return []
    coords, i, lat, lon = [], 0, 0, 0
    while i < len(value):
        delta = []
        for _ in range(2):
            bits = shift = 0
            while True:
                n = ord(value[i]) - 63
                i += 1
                bits |= (n & 31) << shift
                shift += 5
                if n < 32:
                    break
            delta.append(~(bits >> 1) if bits & 1 else bits >> 1)
        lat += delta[0]
        lon += delta[1]
        coords.append([lon / 10**precision, lat / 10**precision])
    return coords


class Schedule:
    def __init__(self, paths, date):
        self.date = dt.date.fromisoformat(date)
        self.zone = ZoneInfo('UTC')
        self.stops, self.trips = {}, {}
        self.active = set()
        self.times = defaultdict(list)
        self.minimum = {}
        self.routes = {}
        self.names = defaultdict(set)
        self.by_stop = defaultdict(set)
        self.pathways = defaultdict(list)
        for feed, path in enumerate(paths):
            with zipfile.ZipFile(path) as z:
                names = {Path(n).name.lower(): n for n in z.namelist()}
                def rows(name):
                    return list(csv.DictReader(io.StringIO(z.read(names[name]).decode('utf-8-sig')))) if name in names else []
                agencies = rows('agency.txt')
                if agencies and agencies[0].get('agency_timezone'):
                    self.zone = ZoneInfo(agencies[0]['agency_timezone'])
                day = date.replace('-', '')
                weekday = self.date.strftime('%A').lower()
                services = {r['service_id'] for r in rows('calendar.txt') if r['start_date'] <= day <= r['end_date'] and r[weekday] == '1'}
                for r in rows('calendar_dates.txt'):
                    if r['date'] == day:
                        (services.add if r['exception_type'] == '1' else services.discard)(r['service_id'])
                for r in rows('stops.txt'):
                    key = (feed, r['stop_id'])
                    self.stops[key] = r
                    self.names[r['stop_name'].casefold()].add(key)
                for r in rows('routes.txt'):
                    self.routes[(feed, r['route_id'])] = r
                for r in rows('pathways.txt'):
                    self.pathways[(feed, r['from_stop_id'], r['to_stop_id'])].append(r)
                    if r.get('is_bidirectional') == '1':
                        self.pathways[(feed, r['to_stop_id'], r['from_stop_id'])].append(r)
                for r in rows('trips.txt'):
                    key = (feed, r['trip_id'])
                    self.trips[key] = r
                    if r['service_id'] in services:
                        self.active.add(key)
                for r in rows('stop_times.txt'):
                    key = (feed, r['trip_id'])
                    if key not in self.active:
                        continue
                    self.times[key].append(r)
                    self.by_stop[(feed, r['stop_id'])].add(key)
                for r in rows('transfers.txt'):
                    # Trip/route-specific rules need a separate rule evaluator.
                    if any(r.get(k) for k in ['from_trip_id', 'to_trip_id', 'from_route_id', 'to_route_id']):
                        continue
                    key = (feed, r['from_stop_id'], r['to_stop_id'])
                    self.minimum[key] = math.inf if r.get('transfer_type') == '3' else float(r.get('min_transfer_time') or 0)
        for values in self.times.values():
            values.sort(key=lambda r: int(r['stop_sequence']))
        self.stop_ids, self.trip_ids = defaultdict(set), defaultdict(set)
        for key in self.stops:
            self.stop_ids[key[1]].add(key)
        for key in self.trips:
            self.trip_ids[key[1]].add(key)

    def seconds(self, value, synthetic=False):
        if value is None:
            return None
        if isinstance(value, (int, float)):
            if value > 1e12:
                value /= 1000
            if value > 1e8:
                value = dt.datetime.fromtimestamp(value, self.zone)
            else:
                return float(value)
        if isinstance(value, str):
            if 'T' not in value and ':' in value:
                h, m, s = map(float, value.split(':'))
                return h * 3600 + m * 60 + s
            value = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if value.tzinfo is not None:
            value = value.astimezone(dt.timezone.utc if synthetic else self.zone)
        return (value.date() - self.date).days * 86400 + value.hour * 3600 + value.minute * 60 + value.second + value.microsecond / 1e6

    @staticmethod
    def suffix(value, wanted):
        return value == wanted or any(value.endswith(separator + wanted) for separator in [':', '\x1f', '_'])

    @staticmethod
    def indexed_keys(index, value):
        value = str(value)
        suffixes = [value] + [value[i + 1:] for i, c in enumerate(value) if c in ':\x1f_']
        return set().union(*(index.get(suffix, ()) for suffix in suffixes))

    def stop_keys(self, ident, name):
        if ident:
            matches = self.indexed_keys(self.stop_ids, ident)
            if matches:
                return matches
        return self.names.get(str(name or '').casefold(), set()) or self.stop_ids.get(name, set())

    def check_ride(self, leg):
        starts = self.stop_keys(leg.get('fromStop'), leg.get('fromName'))
        ends = self.stop_keys(leg.get('toStop'), leg.get('toName'))
        if not starts or not ends or leg['start'] is None or leg['end'] is None:
            return 'unverifiable', None
        candidates = set().union(*(self.by_stop[k] for k in starts))
        if leg.get('trip'):
            identified = self.indexed_keys(self.trip_ids, leg['trip'])
            if identified:
                candidates &= identified
                if not (identified & self.active):
                    return 'inactive_trip', None
        matches = []
        tolerance = max(2, leg.get('timePrecisionSeconds', 1))
        for key in candidates:
            route = self.routes[(key[0], self.trips[key]['route_id'])]
            if leg.get('route') and not any(self.suffix(str(leg['route']), str(v)) for v in [route['route_id'], route.get('route_short_name'), route.get('route_long_name')] if v):
                continue
            stop_times = self.times[key]
            for i, a in enumerate(stop_times):
                if (key[0], a['stop_id']) not in starts or a.get('pickup_type') == '1' or not a.get('departure_time'):
                    continue
                if abs(self.seconds(a['departure_time']) - leg['start']) > tolerance:
                    continue
                for b in stop_times[i + 1:]:
                    if (key[0], b['stop_id']) in ends and b.get('drop_off_type') != '1' and b.get('arrival_time') and abs(self.seconds(b['arrival_time']) - leg['end']) <= tolerance:
                        matches.append((key[0], a['stop_id'], b['stop_id'], key[1]))
        if matches:
            return 'verified', matches[0] if len(set(matches)) == 1 else None
        return 'no_matching_scheduled_ride', None

    def check_access_cost(self, leg, walk_speed):
        """Check component evidence without relaxing the common walking policy."""
        cost = leg.get('accessCost')
        if not cost:
            return None
        if not isinstance(cost, dict):
            return dict(status='invalid_components')
        station, street = cost.get('station', {}), cost.get('street', {})
        if not isinstance(station, dict) or not isinstance(street, dict):
            return dict(status='invalid_components')
        ids = station.get('stopIds', [])
        values = [part.get(key) for part in [station, street] for key in ['seconds', 'distanceKm']]
        if not isinstance(ids, list) or len(ids) < 2 or not all(isinstance(ident, str) for ident in ids) or any(
                not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or v < 0 for v in values):
            return dict(status='invalid_components')
        if leg['start'] is None or leg['end'] is None or leg.get('distanceM') is None:
            return dict(status='unverifiable_components')
        if abs(station['seconds'] + street['seconds'] - (leg['end'] - leg['start'])) > 0.1 or abs(
                (station['distanceKm'] + street['distanceKm']) * 1000 - leg['distanceM']) > 0.01:
            return dict(status='component_total_mismatch')
        if street['seconds'] + 0.1 < street['distanceKm'] * 1000 / (walk_speed / 3.6):
            return dict(status='street_speed_violation')
        # Carry a common feed and directed stop through the entire source path.
        candidates = [(key, 0.0, 0.0, []) for key in self.stop_keys(ids[0], None)]
        for ident in ids[1:]:
            next_candidates = []
            for (feed, start), seconds, meters, witness in candidates:
                for other_feed, end in self.stop_keys(ident, None):
                    if feed != other_feed:
                        continue
                    for edge in self.pathways.get((feed, start, end), []):
                        a, b = self.stops[(feed, start)], self.stops[(feed, end)]
                        try:
                            length = float(edge['length']) if edge.get('length', '').strip() else distance(
                                [float(a['stop_lon']), float(a['stop_lat'])], [float(b['stop_lon']), float(b['stop_lat'])])
                            duration = float(edge['traversal_time']) if edge.get('traversal_time', '').strip() else math.ceil(length / (walk_speed / 3.6))
                        except (ValueError, OverflowError):
                            continue
                        if not math.isfinite(length) or not math.isfinite(duration) or min(length, duration) < 0:
                            continue
                        next_candidates.append(((feed, end), seconds + duration, meters + length,
                                                witness + [edge.get('pathway_id')]))
                        if len(next_candidates) > 1024:
                            return dict(status='ambiguous_source_path')
            candidates = next_candidates
        matches = [(key[0], witness) for key, seconds, meters, witness in candidates
                   if abs(seconds - station['seconds']) < 0.1 and abs(meters - station['distanceKm'] * 1000) < 0.01]
        return dict(status='source_pathway_cost_verified' if matches else 'source_pathway_cost_unverified',
                    sourceWitnesses=[dict(feed=feed, pathwayIds=witness) for feed, witness in matches])


def normalize(engine, itinerary, schedule):
    out = []
    synthetic = engine in {'R5', 'R5py'}
    def add(mode, start=None, end=None, coords=None, **extra):
        mode = str(mode).lower()
        kind = 'walk' if mode in {'walk', 'walking', 'foot', 'access_walk', 'egress_walk', 'transfer'} else 'wait' if mode in {'wait', 'waiting'} else 'ride'
        out.append(dict(mode=kind, start=schedule.seconds(start, synthetic), end=schedule.seconds(end, synthetic), coordinates=coords or [], **extra))
    if engine in {'VIGO', 'VIGO-py'}:
        for leg in itinerary.get('legs', []):
            add(leg['type'], leg.get('startMinutes', 0) * 60, leg.get('endMinutes', 0) * 60, leg.get('coordinates'),
                fromStop=leg.get('fromStopId'), toStop=leg.get('toStopId'), fromName=leg.get('fromName'), toName=leg.get('toName'),
                trip=leg.get('tripId'), route=leg.get('routeId'), distanceM=leg.get('distanceKm', 0) * 1000,
                streetClaim=leg.get('streetPathVerified', False), connector=leg.get('endpointConnector'),
                accessCost=leg.get('accessCost'))
    elif engine == 'ULTRA-OSM':
        for leg in itinerary.get('legs', []):
            add(leg['mode'], leg['departureTime'], leg['arrivalTime'], leg.get('coordinates'), fromName=leg.get('fromName'), toName=leg.get('toName'), route=(leg.get('routeName') or '').split(']')[0].lstrip('[') if (leg.get('routeName') or '').startswith('[') else leg.get('routeName'))
    elif engine in {'R5', 'R5py'}:
        for leg in itinerary.get('legs', []):
            start = schedule.seconds(leg['departure_time'], True)
            geometry = leg.get('geometry') or {}
            coordinates = geometry.get('coordinates', [])
            multipart = geometry.get('type') == 'MultiLineString'
            if multipart:
                coordinates = [point for line in coordinates for point in line]
            add(leg['transport_mode'], start, start + leg['travel_time'], coordinates,
                fromStop=leg.get('start_stop_id'), toStop=leg.get('end_stop_id'), route=leg.get('route_id'), distanceM=leg.get('distance'), multipart=multipart)
    elif engine in {'OTP', 'MOTIS'}:
        for leg in itinerary.get('legs', []):
            a, b = leg.get('from') or {}, leg.get('to') or {}
            geo = leg.get('legGeometry') or {}
            start = leg.get('start', {}).get('scheduledTime') if engine == 'OTP' else leg.get('startTime')
            end = leg.get('end', {}).get('scheduledTime') if engine == 'OTP' else leg.get('endTime')
            add(leg['mode'], start, end, decode_polyline(geo.get('points'), geo.get('precision', 5)), fromStop=(a.get('stop') or {}).get('gtfsId') or a.get('stopId'),
                toStop=(b.get('stop') or {}).get('gtfsId') or b.get('stopId'), fromName=a.get('name'), toName=b.get('name'),
                route=(leg.get('route') or {}).get('gtfsId') if isinstance(leg.get('route'), dict) else leg.get('routeId'),
                trip=(leg.get('trip') or {}).get('gtfsId') if isinstance(leg.get('trip'), dict) else leg.get('tripId'), distanceM=leg.get('distance'),
                interlineWithPreviousLeg=bool(leg.get('interlineWithPreviousLeg')),
                timePrecisionSeconds=60 if engine == 'MOTIS' else 1)
    elif engine == 'GraphHopper':
        for leg in itinerary.get('legs', []):
            geometry = leg.get('geometry') or {}
            stops = leg.get('stops') or []
            add(leg['type'], leg.get('departure_time'), leg.get('arrival_time'), geometry.get('coordinates'), route=leg.get('route_id'), trip=leg.get('trip_id'),
                fromStop=stops[0].get('stop_id') if stops else None, toStop=stops[-1].get('stop_id') if stops else None,
                fromName=stops[0].get('stop_name') if stops else None, toName=stops[-1].get('stop_name') if stops else None,
                distanceM=leg.get('distance'))
    elif engine == 'Valhalla':
        for whole in itinerary.get('legs', []):
            shape = decode_polyline(whole.get('shape'), 6)
            clock = (itinerary.get('locations') or [{}])[0].get('date_time')
            for leg in whole.get('maneuvers', []):
                coords = shape[leg.get('begin_shape_index', 0):leg.get('end_shape_index', 0) + 1]
                info = leg.get('transit_info') or {}
                stops = info.get('transit_stops') or []
                start = stops[0].get('departure_date_time') if stops else clock
                end = stops[-1].get('arrival_date_time') if stops else None
                if end is None and start is not None:
                    end = schedule.seconds(start) + leg.get('time', 0)
                add(leg.get('travel_mode', 'pedestrian').replace('pedestrian', 'walk'), start, end, coords,
                    fromName=stops[0].get('name') if stops else None, toName=stops[-1].get('name') if stops else None,
                    route=info.get('short_name'), distanceM=leg.get('length', 0) * 1000, timePrecisionSeconds=60)
                clock = end
    return out


def audit(row, engine, schedule, controls, departure):
    if row['status'] != 'ready':
        return dict(status=row['status'], issues=[], unknown=[])
    itinerary = row.get('itinerary')
    if not isinstance(itinerary, dict):
        return dict(status='unverifiable', issues=[], unknown=['missing_itinerary'])
    legs = normalize(engine, itinerary, schedule)
    access_cost_checks = [dict(leg=index, **result) for index, leg in enumerate(legs)
                          if leg['mode'] == 'walk' and (result := schedule.check_access_cost(leg, controls['walkSpeedKph']))]
    issues, unknown = set(), set()
    for check in access_cost_checks:
        if check['status'] in {'invalid_components', 'component_total_mismatch', 'street_speed_violation'}:
            issues.add('invalid_access_cost_evidence')
        elif check['status'] != 'source_pathway_cost_verified':
            unknown.add('station_pathway_cost_not_verified')
    if not legs:
        return dict(status='unverifiable', issues=[], unknown=['missing_legs'])
    rides = [i for i, leg in enumerate(legs) if leg['mode'] == 'ride']
    interlining = sum(bool(legs[i].get('interlineWithPreviousLeg')) for i in rides)
    boardings = len(rides) - interlining
    if interlining:
        unknown.add('declared_through_service_not_independently_verified')
        if legs[rides[0]].get('interlineWithPreviousLeg'):
            issues.add('invalid_interlining_sequence')
    if not rides:
        issues.add('walk_only')
    if boardings > controls['maxTransfers'] + 1:
        issues.add('transfer_cap_exceeded')
    real = [leg for leg in legs if leg['mode'] != 'wait']
    previous = None
    scheduled = 0
    witnesses = []
    for leg in real:
        if leg.get('multipart'):
            unknown.add('multipart_geometry_continuity_not_proven')
        if leg['start'] is None or leg['end'] is None:
            unknown.add('missing_leg_times')
        else:
            precision = max(2, leg.get('timePrecisionSeconds', 1))
            if leg['end'] < leg['start'] - precision or leg['start'] < departure - precision:
                issues.add('invalid_leg_time')
            if previous and previous['end'] is not None and leg['start'] < previous['end'] - precision:
                issues.add('overlapping_legs')
        if previous and previous['coordinates'] and leg['coordinates']:
            # Two metres covers the coarsest returned polyline encoding.
            # Larger gaps need an explicit connector, not an assumed walk.
            if distance(previous['coordinates'][-1], leg['coordinates'][0]) > 2:
                issues.add('disconnected_leg_geometry')
        if leg['mode'] == 'ride':
            result, witness = schedule.check_ride(leg)
            if result == 'verified':
                if leg.get('timePrecisionSeconds', 1) > 2:
                    unknown.add('schedule_matches_only_at_minute_precision')
                scheduled += 1
                if witness is None:
                    unknown.add('ambiguous_scheduled_trip_witness')
                witnesses.append((leg, witness))
            elif result == 'unverifiable':
                unknown.add('schedule_not_verifiable')
            else:
                issues.add(result)
        else:
            if not leg['coordinates']:
                unknown.add('missing_walk_geometry')
            length = leg.get('distanceM')
            if length is None:
                length = line_length(leg['coordinates'])
                unknown.add('walk_distance_from_geometry_only')
            leg['checkedDistanceM'] = length
            if length is not None and leg['start'] is not None and leg['end'] is not None:
                if leg['end'] - leg['start'] + max(2, leg.get('timePrecisionSeconds', 1)) < length / (controls['walkSpeedKph'] / 3.6):
                    issues.add('walk_faster_than_common_speed')
        previous = leg
    for (a, wa), (b, wb) in zip(witnesses, witnesses[1:]):
        if wa and wb and wa[0] == wb[0] and not b.get('interlineWithPreviousLeg'):
            minimum = schedule.minimum.get((wa[0], wa[2], wb[1]), 0)
            if b['start'] - a['end'] + 2 < minimum:
                issues.add('published_transfer_minimum_violated')
    # Resolve station usage from independently matched original-feed rides,
    # including old engine output that predates station-access diagnostics.
    # A street polyline or an engine's assumed station penalty cannot establish
    # the interior path. Declared pathways also require a separate path audit.
    station_access = []
    for leg, witness in witnesses:
        if witness is None:
            continue
        feed, boarding, alighting, trip = witness
        route = schedule.routes[(feed, schedule.trips[(feed, trip)]['route_id'])]
        index = next(i for i, value in enumerate(real) if value is leg)
        for role, stop_id, neighbor in [('boarding', boarding, index - 1), ('alighting', alighting, index + 1)]:
            stop = schedule.stops[(feed, stop_id)]
            station = route.get('route_type') in {'1', '401', '402'} or bool(stop.get('parent_station'))
            if not station or stop.get('stop_access') == '1':
                continue
            walk = real[neighbor] if 0 <= neighbor < len(real) else None
            if walk is not None and walk['mode'] != 'walk':
                continue
            endpoint = row['origin' if role == 'boarding' else 'destination']
            if (walk is None or not walk.get('fromStop') or not walk.get('toStop')) and endpoint.get('source') == 'stop' and schedule.suffix(str(endpoint.get('stopId', '')), stop_id):
                continue
            if walk and walk.get('fromStop') and walk.get('fromStop') == walk.get('toStop'):
                continue
            unknown.add('station_access_not_independently_verified')
            station_access.append(dict(feed=feed, stopId=stop_id, stopName=stop['stop_name'], role=role,
                                       streetClaim=walk.get('streetClaim', False) if walk else False))
    def walking(part):
        values = [leg.get('checkedDistanceM') for leg in part if leg['mode'] == 'walk']
        return None if any(v is None for v in values) else sum(values)
    walk = walking(legs)
    access = walking(legs[:rides[0]]) if rides else walk
    egress = walking(legs[rides[-1] + 1:]) if rides else 0
    if any(value is not None and value > controls['maxWalkKm'] * 1000 + 5 for value in [access, egress]):
        issues.add('endpoint_walk_budget_exceeded')
    for side, leg, coordinate in [('origin', real[0], row['origin']['coordinate']), ('destination', real[-1], row['destination']['coordinate'])]:
        if leg.get('connector'):
            unknown.add('coordinate_snap_connector_not_a_mapped_street')
        if not leg['coordinates']:
            unknown.add('endpoint_geometry_missing')
        elif distance(coordinate, (leg.get('connector') or {}).get('coordinates', leg['coordinates'])[0 if side == 'origin' else -1]) > 2:
            issues.add('endpoint_geometry_mismatch')
    arrival = max((l['end'] for l in legs if l['end'] is not None), default=None)
    if arrival is not None and arrival - departure > controls['horizonMinutes'] * 60 + 2:
        issues.add('horizon_exceeded')
    if engine == 'ULTRA-OSM':
        unknown.add('contracted_street_geometry')
    # Geometry presence is not a proof of legal traversability on the original PBF.
    unknown.add('street_legality_requires_independent_osm_check')
    policy_issues = issues & {'walk_only', 'transfer_cap_exceeded', 'walk_faster_than_common_speed', 'endpoint_walk_budget_exceeded', 'horizon_exceeded'}
    geometry_issues = issues & {'endpoint_geometry_mismatch', 'disconnected_leg_geometry'}
    feasibility_issues = issues - policy_issues - geometry_issues
    status = 'invalid' if policy_issues or feasibility_issues else (
        'checks_passed' if scheduled == len(rides) and rides and not geometry_issues and not station_access else 'unverifiable')
    return dict(status=status,
                issues=sorted(issues), unknown=sorted(unknown), boardings=boardings, rideLegs=len(rides),
                throughServiceContinuations=interlining, scheduledRidesVerified=scheduled,
                stationAccessChecks=station_access,
                accessCostChecks=access_cost_checks,
                commonPolicyIssues=sorted(policy_issues), feasibilityIssues=sorted(feasibility_issues), geometryIssues=sorted(geometry_issues),
                durationMinutes=(arrival - departure) / 60 if arrival is not None else None,
                walkingMeters=walk, accessMeters=access, egressMeters=egress,
                geometryPoints=sum(len(l['coordinates']) for l in legs))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    args = parser.parse_args()
    summary = json.loads((args.run / 'summary.json').read_text())
    totals = []
    for city in summary['cities']:
        context = json.loads((args.run / city['citySlug'] / 'context.json').read_text())
        controls = dict(context['comparison'], maxWalkKm=context['maxWalkKm'])
        schedule = Schedule(context['gtfs'], context['serviceDate'])
        hour, minute = map(int, context['time'].split(':'))
        departure = hour * 3600 + minute * 60
        for engine in city['engines']:
            if engine['engine'] not in {'VIGO', 'VIGO-py', 'MOTIS', 'ULTRA-OSM', 'R5', 'R5py', 'OTP', 'Valhalla', 'GraphHopper'}:
                continue
            source = args.run / city['citySlug'] / engine['engine'].lower().replace('-', '_') / 'queries.ndjson'
            if not source.exists():
                source = args.run / city['citySlug'] / engine['engine'].lower().replace('-', '') / 'queries.ndjson'
            if not source.exists():
                # Directory names use hyphens, except engine aliases in older retained runs.
                source = args.run / city['citySlug'] / engine['engine'].lower() / 'queries.ndjson'
            if not source.exists():
                totals.append(dict(engine=engine['engine'], setupStatus=engine['status'], counts={}, issues={}))
                continue
            counts, issues, unknown = Counter(), Counter(), Counter()
            results = []
            for line in source.open():
                row = json.loads(line)
                try:
                    result = audit(row, engine['engine'], schedule, controls, departure)
                except Exception as error:
                    result = dict(status='unverifiable', issues=[], unknown=['normalization_error'], detail=str(error))
                counts[result['status']] += 1
                issues.update(result['issues'])
                unknown.update(result['unknown'])
                results.append(dict(id=row['id'], odId=row['odId'], odType=row['odType'], **result))
            (source.parent / 'quality.ndjson').write_text(''.join(json.dumps(r) + '\n' for r in results))
            totals.append(dict(engine=engine['engine'], counts=dict(counts), issues=dict(issues), unknown=dict(unknown)))
    report = {'scope': 'Retained itineraries; original GTFS schedule, transfer minima, chronology, endpoint budgets, geometry continuity and requested transit/transfer/horizon policy.',
              'limits': 'No-itinerary is not proved unreachable. Checks passed is not a street-legal or globally optimal route certificate. Engine limitations and walking graph differences remain explicit.',
              'engines': totals}
    (args.run / 'quality-summary.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
