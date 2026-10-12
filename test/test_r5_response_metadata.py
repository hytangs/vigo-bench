"""Fresh-build metadata must not discard successfully computed route responses."""
import ast
import io
import json
import os
from pathlib import Path
import sys
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/r5-engine-adapter.py'


class ResponseMetadataTest(unittest.TestCase):
    def run_query(self, metadata, status, engine='R5'):
        tree = ast.parse(SOURCE.read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        com = ModuleType('com')
        conveyal = ModuleType('com.conveyal')
        r5 = ModuleType('com.conveyal.r5')
        profile = ModuleType('com.conveyal.r5.profile')
        com.conveyal = conveyal
        conveyal.r5 = r5
        r5.profile = profile
        profile.McRaptorSuboptimalPathProfileRouter = SimpleNamespace(
            VIGO_BENCH_FIXED_DEPARTURE=True, createSuboptimalListSupplier=object())
        calls = []
        def route(network, request, settings):
            calls.append(request['id'])
            return ['computed itinerary'] if status == 'ready' else []
        scope = dict(os=os, sys=sys, json=json, time=time, context=lambda: {},
                     load_network=lambda: (object(), metadata), raw_r5_routes=route,
                     r5py_routes=route, route_payload=lambda routes, request, settings, engine:
                     {'id': request['id'], 'status': status, 'itinerary': routes})
        exec(compile(ast.Module([main], type_ignores=[]), str(SOURCE), 'exec'), scope)
        output = io.StringIO()
        with patch.dict(sys.modules, {m.__name__: m for m in [com, conveyal, r5, profile]}), \
             patch.dict(os.environ, {'VIGO_BENCH_PHASE': 'query', 'VIGO_BENCH_ENGINE': engine}), \
             patch.object(sys, 'stdin', io.StringIO('{"id":"sample"}\n')), \
             patch.object(sys, 'stdout', output):
            scope['main']()
        self.assertEqual(calls, ['sample'])
        response = json.loads(output.getvalue())
        self.assertEqual(response['status'], status)
        self.assertIn('queryMs', response)
        return response

    def test_fresh_network_returns_ready_and_blocked_results(self):
        for engine in ['R5', 'R5py']:
            for status in ['ready', 'blocked']:
                with self.subTest(engine=engine, status=status):
                    result = self.run_query([{'source': 'feed.zip', 'modified': False}], status, engine)
                    self.assertNotIn('networkSource', result)

    def test_retained_network_keeps_readonly_provenance(self):
        metadata = {'retainedNetwork': '/retained/network', 'readOnly': True}
        self.assertEqual(self.run_query(metadata, 'ready')['networkSource'], metadata)


if __name__ == '__main__':
    unittest.main()
