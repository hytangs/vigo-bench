import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('audit', Path(__file__).parents[1] / 'scripts/audit-itineraries.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class ItineraryAuditTest(unittest.TestCase):
    def test_indexed_ids_preserve_all_namespace_and_underscore_matches(self):
        index = {'T': {(0, 'T'), (1, 'T')}, 'line_T': {(0, 'line_T')}, 'A:T': {(1, 'A:T')}}
        keys = set().union(*index.values())
        for value in ['T', 'line_T', 'feed:line_T', 'feed\x1fline_T', 'A:T', 'feed:A:T', 'missing']:
            self.assertEqual(audit.Schedule.indexed_keys(index, value),
                             {key for key in keys if audit.Schedule.suffix(value, key[1])})

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        feed = Path(self.temporary.name) / 'feed.zip'
        with zipfile.ZipFile(feed, 'w') as z:
            z.writestr('agency.txt', 'agency_timezone\nUTC\n')
            z.writestr('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,0,0\nB,Beta,0,0.01\n')
            z.writestr('routes.txt', 'route_id,route_short_name\nR,1\n')
            z.writestr('trips.txt', 'trip_id,route_id,service_id\nT,R,active\nOFF,R,inactive\n')
            z.writestr('calendar_dates.txt', 'service_id,date,exception_type\nactive,20260714,1\n')
            z.writestr('stop_times.txt', 'trip_id,stop_id,stop_sequence,arrival_time,departure_time,pickup_type,drop_off_type\nT,A,1,08:01:00,08:01:00,0,0\nT,B,2,08:11:00,08:11:00,0,0\nOFF,A,1,08:01:00,08:01:00,0,0\nOFF,B,2,08:11:00,08:11:00,0,0\n')
        self.schedule = audit.Schedule([feed], '2026-07-14')
        self.controls = dict(maxTransfers=3, maxWalkKm=1.2, walkSpeedKph=4.8, horizonMinutes=240)
        self.row = dict(status='ready', origin={'coordinate': [0, 0]}, destination={'coordinate': [0.01, 0]},
                        itinerary={'legs': [dict(type='ride', startMinutes=481, endMinutes=491,
                            fromStopId='A', toStopId='B', routeId='R', tripId='T', coordinates=[[0, 0], [0.01, 0]])]})

    def check(self, row=None):
        return audit.audit(row or self.row, 'VIGO', self.schedule, self.controls, 28800)

    def test_schedule_witness_and_unchanged_raw_evidence(self):
        before = copy.deepcopy(self.row)
        result = self.check()
        self.assertEqual(result['status'], 'checks_passed')
        self.assertEqual(result['durationMinutes'], 11)  # Includes initial wait.
        self.assertEqual(self.row, before)

    def test_inactive_trip_is_not_a_valid_route(self):
        self.row['itinerary']['legs'][0]['tripId'] = 'OFF'
        self.assertIn('inactive_trip', self.check()['issues'])

    def test_station_access_is_not_verified_by_street_claim_or_schedule(self):
        self.schedule.routes[(0, 'R')]['route_type'] = '1'
        self.row['itinerary']['legs'].insert(0, dict(type='walk', startMinutes=480, endMinutes=481,
            toStopId='A', distanceKm=0, coordinates=[[0, 0], [0, 0]], streetPathVerified=True))
        before = copy.deepcopy(self.row)
        result = self.check()
        self.assertEqual(result['scheduledRidesVerified'], 1)
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['status'], 'unverifiable')
        self.assertIn('station_access_not_independently_verified', result['unknown'])
        self.assertEqual([r['stopId'] for r in result['stationAccessChecks']], ['A', 'B'])
        self.assertTrue(result['stationAccessChecks'][0]['streetClaim'])
        self.assertEqual(self.row, before)

    def test_explicit_platform_endpoints_need_no_station_entry(self):
        self.schedule.routes[(0, 'R')]['route_type'] = '1'
        self.row['origin'].update(source='stop', stopId='A')
        self.row['destination'].update(source='stop', stopId='B')
        self.assertEqual(self.check()['status'], 'checks_passed')

    def test_remaining_seated_is_not_an_additional_boarding(self):
        first = dict(mode='BUS', startTime='08:01:00', endTime='08:11:00')
        second = dict(mode='BUS', startTime='08:11:00', endTime='08:21:00', interlineWithPreviousLeg=True)
        row = dict(self.row, itinerary={'legs': [first, second]})
        with patch.object(self.schedule, 'check_ride', return_value=('verified', None)):
            result = audit.audit(row, 'MOTIS', self.schedule, dict(self.controls, maxTransfers=0), 28800)
        self.assertNotIn('transfer_cap_exceeded', result['issues'])
        self.assertEqual(result['boardings'], 1)
        self.assertEqual(result['rideLegs'], result['scheduledRidesVerified'])
        self.assertEqual(result['rideLegs'], 2)
        self.assertIn('declared_through_service_not_independently_verified', result['unknown'])

    def test_scalar_and_no_route_are_not_feasibility_certificates(self):
        self.assertEqual(self.check(dict(self.row, itinerary=None))['status'], 'unverifiable')
        self.assertEqual(self.check(dict(self.row, status='blocked'))['status'], 'blocked')

    def test_source_pathway_cost_does_not_erase_uniform_speed_violation(self):
        self.schedule.pathways[(0, 'A', 'B')] = [dict(pathway_id='moving-walkway', length='100', traversal_time='10')]
        leg = dict(type='walk', startMinutes=480, endMinutes=481, distanceKm=1 / 6,
                   coordinates=[[0, 0], [0, 0]], accessCost={
                       'street': dict(distanceKm=1 / 15, seconds=50),
                       'station': dict(stopIds=['A', 'B'], distanceKm=0.1, seconds=10, sources=['gtfs_pathway'])})
        self.row['itinerary']['legs'].insert(0, leg)
        result = self.check()
        self.assertIn('walk_faster_than_common_speed', result['commonPolicyIssues'])
        self.assertEqual(result['accessCostChecks'][0]['status'], 'source_pathway_cost_verified')
        # A claimed source path alone cannot validate its cost or direction.
        leg['accessCost']['station']['stopIds'].reverse()
        self.assertEqual(self.check()['accessCostChecks'][0]['status'], 'source_pathway_cost_unverified')
        leg['accessCost']['street']['seconds'] = 49
        self.assertEqual(self.check()['accessCostChecks'][0]['status'], 'component_total_mismatch')

    def test_endpoint_connector_is_explicitly_unverified(self):
        self.row['origin']['coordinate'] = [-0.0006, 0]
        self.row['itinerary']['legs'].insert(0, dict(type='walk', startMinutes=480, endMinutes=481,
            distanceKm=0.075, coordinates=[[0, 0], [0, 0]],
            endpointConnector={'coordinates': [[-0.0006, 0], [0, 0]], 'streetPathVerified': False}))
        result = self.check()
        self.assertNotIn('endpoint_geometry_mismatch', result['issues'])
        self.assertIn('coordinate_snap_connector_not_a_mapped_street', result['unknown'])

    def test_native_feed_prefixes_and_polyline_precision(self):
        itinerary = {'legs': [dict(mode='BUS', startTime='08:01:00', endTime='08:11:00',
            **{'from': {'stopId': 'feed_A'}, 'to': {'stopId': 'feed_B'}},
            tripId='20260714_08:01_feed_T', routeId='feed_R',
            legGeometry={'points': '_p~iF~ps|U', 'precision': 6})]}
        leg = audit.normalize('MOTIS', itinerary, self.schedule)[0]
        self.assertEqual(leg['coordinates'], [[-12.02, 3.85]])
        self.assertEqual(self.schedule.check_ride(leg)[0], 'verified')

    def test_multipart_geometry_remains_explicit(self):
        leg = dict(transport_mode='WALK', departure_time='2026-07-14T08:00:00Z', travel_time=200,
                   geometry={'type': 'MultiLineString', 'coordinates': [[[0, 0], [0.001, 0]], [[0.001, 0], [0.002, 0]]]})
        normalized = audit.normalize('R5', {'legs': [leg]}, self.schedule)[0]
        self.assertEqual(len(normalized['coordinates']), 4)
        self.assertTrue(normalized['multipart'])


if __name__ == '__main__':
    unittest.main()
