import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('comparison', Path(__file__).parents[1] / 'scripts/compare-route-quality.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class Clock:
    def seconds(self, value, synthetic=False):
        if isinstance(value, str):
            hour, minute, second = map(float, value.split(':'))
            return 3600 * hour + 60 * minute + second
        return value


class RouteComparisonTest(unittest.TestCase):
    def test_no_common_success_retains_coverage_without_inventing_agreement(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            summary = {'city': 'washington', 'common_cohorts': {'common_success': {'n': 0}},
                       'coverage': {'VIGO': {'native_statuses': {'ready': 2}, 'transit_metrics': 2},
                                    'OTP': {'native_statuses': {'blocked': 2}, 'transit_metrics': 0}}}
            (output / 'summary.json').write_text(json.dumps(summary))
            comparison.write_csv(output / 'paired-differences.csv', [])
            comparison.write_report(output)
            report = (output / 'REPORT.md').read_text()
            self.assertIn('relative disagreement is undefined', report)
            self.assertIn('| OTP | 0 | 2 | 0 | 0 |', report)
            self.assertFalse((output / 'disagreement-ecdf.pdf').exists())

    def test_shifted_departure_does_not_remove_initial_wait(self):
        row = {'status': 'ready', 'itinerary': {'legs': [
            {'mode': 'WALK', 'startTime': '08:10:00', 'endTime': '08:15:00', 'distance': 400},
            {'mode': 'BUS', 'startTime': '08:20:00', 'endTime': '08:30:00'},
            {'mode': 'WALK', 'startTime': '08:30:00', 'endTime': '08:35:00', 'distance': 400}]}}
        metric = comparison.route_metrics('MOTIS', row, Clock(), 8 * 3600)
        self.assertEqual(metric['arrival_minutes'], 35)
        self.assertEqual(metric['waiting_minutes'], 15)
        self.assertEqual(metric['initial_wait_minutes'], 10)
        self.assertEqual(metric['generalized_minutes'], 60)

    def test_same_od_intersection_for_every_primary_comparison(self):
        data = {'VIGO': {'one': 1, 'two': 2}, 'R5': {'one': 1, 'two': 2},
                'MOTIS': {'one': 1}, 'OTP': {'one': 1, 'three': 3}}
        self.assertEqual(comparison.common_ids(data, comparison.PRIMARY), ['one'])
        self.assertEqual(comparison.common_ids(data, comparison.PRIMARY, lambda e, od: e != 'OTP'), [])

    def test_paired_baseline_does_not_treat_wrappers_as_references(self):
        a, b = comparison.relative_disagreement([[12, 10, 12, 14], [20, 10, 10, 10]])
        np.testing.assert_equal(a, [[2, 0, 2], [10, 10, 10]])
        np.testing.assert_equal(b, [[2, 4, 2], [0, 0, 0]])
        self.assertNotIn('VIGO-py', comparison.PRIMARY)
        self.assertNotIn('R5py', comparison.PRIMARY)

    def test_bootstrap_keeps_joint_od_strata(self):
        indices = comparison.bootstrap_indices(['random', 'pivot', 'random', 'pivot'], 100, 8)
        self.assertTrue(all(sum(i % 2 == 0 for i in row) == 2 for row in indices))
        np.testing.assert_equal(indices, comparison.bootstrap_indices(['random', 'pivot', 'random', 'pivot'], 100, 8))

    def test_disagreement_retains_bias_tails_and_tolerances(self):
        result = comparison.disagreement([-10, -1, 0, 1, 10], 'arrival_minutes')
        self.assertEqual(result['signed_mean'], 0)
        self.assertEqual(result['mae'], 4.4)
        self.assertEqual(result['absolute_p95'], 10)
        self.assertEqual(result['within_1'], 0.6)

    def test_unit_weights_recover_elapsed_duration(self):
        row = dict(ride_minutes=12, walking_minutes=8, waiting_minutes=20, transfers=2)
        self.assertEqual(comparison.generalized(row, 1, 1, 0), 40)
        self.assertEqual(comparison.generalized(row), 78)

    def test_missing_distance_is_not_imputed_but_arrival_remains_available(self):
        row = {'status': 'ready', 'itinerary': {'legs': [
            {'mode': 'WALK', 'startTime': '08:10:00', 'endTime': '08:15:00'},
            {'mode': 'BUS', 'startTime': '08:20:00', 'endTime': '08:30:00'}]}}
        with self.assertRaises(ValueError):
            comparison.route_metrics('MOTIS', row, Clock(), 8 * 3600)
        metric = comparison.route_metrics('MOTIS', row, Clock(), 8 * 3600, missing_distance_ok=True)
        self.assertIsNone(metric['walking_meters'])
        self.assertEqual(metric['arrival_minutes'], 30)

    def test_equal_type_weights_do_not_let_larger_success_stratum_dominate(self):
        values = [[20, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10]]
        indices = comparison.bootstrap_indices(['random', 'pivot', 'pivot'], 100, 8)
        conditional = comparison.relative_summary(values, indices)
        balanced = comparison.relative_summary(values, indices, [.5, .25, .25])
        self.assertAlmostEqual(conditional['mean_excess'], 10 / 3)
        self.assertEqual(balanced['mean_excess'], 5)
        self.assertEqual(balanced['excess_ci_low'], 5)
        self.assertEqual(balanced['excess_ci_high'], 5)


if __name__ == '__main__':
    unittest.main()
