"""VIGO-py receives no opening-time subtraction from its measured API call."""
import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ADAPTER = Path(__file__).parents[1] / 'scripts/python-api-adapter.py'
spec = importlib.util.spec_from_file_location('python_adapter', ADAPTER)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class PythonApiTimingTests(unittest.TestCase):
    def test_declared_timer_retains_lazy_opening(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'vigo.py').write_text('''
import json
__version__ = '0.5.0'
class City:
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def route(self,*args,**kwargs): return Result()
class Result:
    timing = {'openMs': 10000}
    def to_json(self,indent=None): return json.dumps({'kind':'route','result':{'status':'ready'}})
def open(*args,**kwargs):
    assert kwargs['runtime'] == ['/selected/node', '/selected/vigo.mjs']
    return City()
''')
            context = root / 'context.json'
            context.write_text(json.dumps({'time':'08:00','serviceDate':'2026-09-22','maxWalkKm':1.2,'comparison':{'maxTransfers':3,'horizonMinutes':240}}))
            environment = {**os.environ, 'VIGO_BENCH_PYTHON_SOURCE':str(root), 'VIGO_BENCH_VIGO_CLI':'unused',
                'VIGO_BENCH_VIGO_COMMAND_JSON': json.dumps(['/selected/node', '/selected/vigo.mjs']),
                'VIGO_BENCH_NETWORK_DIR':str(root), 'VIGO_BENCH_CONTEXT':str(context), 'VIGO_BENCH_PHASE':'query'}
            result = subprocess.run([sys.executable,str(ADAPTER)],env=environment,
                input='not json\n[]\n'+json.dumps({'id':'q','origin':{},'destination':{}})+'\n',text=True,capture_output=True,check=True)
            malformed, wrong_type, response = map(json.loads, result.stdout.splitlines())
            self.assertEqual(malformed['status'], 'error')
            self.assertEqual(wrong_type['status'], 'error')
            self.assertEqual(response['id'], 'q', 'Bad lines must not terminate a resident adapter')
            self.assertGreater(response['queryMs'],0)
            self.assertEqual(response['queryMs'],response['timing']['pythonApiAndSerializationMs'])
            self.assertEqual(response['timing']['openMs'],10000)

    def test_per_request_controls_include_arrival_walking_and_transfer_limits(self):
        context = {'time': '08:00', 'serviceDate': '2026-10-08', 'maxWalkKm': 1.2,
                   'comparison': {'maxTransfers': 3, 'horizonMinutes': 240}}
        request = {'timePreference': 'arrive_by', 'time': '09:13', 'serviceDate': '2026-10-09',
                   'maxWalkKm': .4, 'maxTransfers': 0, 'horizonMinutes': 37,
                   'disableCache': True, 'requireTransitRide': False, 'waypoints': ['X']}
        result = adapter.route_options(request, context)
        self.assertEqual(result['arrive_by'], '09:13')
        self.assertNotIn('depart_at', result)
        self.assertEqual(result['service_date'], '2026-10-09')
        self.assertEqual(result['max_transfers'], 0)
        self.assertEqual(result['max_walk_km'], .4)
        self.assertEqual(result['horizon_minutes'], 37)
        self.assertFalse(result['require_transit_ride'])
        self.assertTrue(result['disable_cache'])
        self.assertEqual(result['waypoints'], ['X'])
        for invalid in ({'timePreference': 'banana'}, {'kind': 'matrix'}, {'arrivalBufferMinutes': 5}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                adapter.route_options(invalid, context)
        with self.assertRaisesRegex(ValueError, 'earliest_arrival'):
            adapter.route_options({}, dict(context, routingPreference='balanced'))
