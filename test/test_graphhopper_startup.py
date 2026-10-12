import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import Mock, patch


class GraphHopperStartupTests(unittest.TestCase):
    def test_default_heap_and_explicit_override(self):
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory) / 'context.json'
            context.write_text('{}')
            jar = Path(directory) / 'compatible.jar'
            with zipfile.ZipFile(jar, 'w') as archive:
                archive.writestr('vigo-bench-walk-speed-v1.java.txt', 'fixture')
            environment = dict(VIGO_BENCH_WORKDIR=directory, VIGO_BENCH_OSM_PBF='unused.pbf',
                               VIGO_BENCH_GTFS_PATHS_JSON='[]', VIGO_BENCH_CONTEXT=str(context),
                               VIGO_BENCH_GRAPHHOPPER_JAR=str(jar))
            spec = importlib.util.spec_from_file_location('graphhopper_adapter',
                Path(__file__).parents[1] / 'scripts/graphhopper-engine-adapter.py')
            adapter = importlib.util.module_from_spec(spec)
            with patch.dict(os.environ, environment, clear=True):
                spec.loader.exec_module(adapter)
                for override, expected in [(None, 10), ('4', 4)]:
                    with self.subTest(override=override):
                        if override is not None:
                            os.environ['VIGO_GRAPHHOPPER_HEAP_GB'] = override
                        with patch.object(adapter.subprocess, 'Popen') as launch, \
                             patch.object(adapter.atexit, 'register'):
                            launch.return_value.poll.return_value = 0
                            server = adapter.GraphHopperProcess()
                            self.assertIn(f'-Xmx{expected}G', launch.call_args.args[0])
                            self.assertIn('-Xms256m', launch.call_args.args[0])
                            self.assertEqual(server.heap_gb, expected)
                            server.close()
                with zipfile.ZipFile(jar, 'w') as archive:
                    archive.writestr('unpatched', '')
                with self.assertRaisesRegex(RuntimeError, 'walking-speed compatibility JAR'), patch.object(adapter.subprocess, 'Popen') as launch:
                    adapter.GraphHopperProcess()
                launch.assert_not_called()

    def test_connection_reset_retains_native_exit_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            context = Path(directory) / 'context.json'
            context.write_text(json.dumps({}))
            environment = dict(VIGO_BENCH_WORKDIR=directory, VIGO_BENCH_OSM_PBF='unused.pbf',
                               VIGO_BENCH_GTFS_PATHS_JSON='[]', VIGO_BENCH_CONTEXT=str(context),
                               VIGO_BENCH_GRAPHHOPPER_JAR='unused.jar')
            spec = importlib.util.spec_from_file_location('graphhopper_adapter',
                Path(__file__).parents[1] / 'scripts/graphhopper-engine-adapter.py')
            adapter = importlib.util.module_from_spec(spec)
            with patch.dict(os.environ, environment):
                spec.loader.exec_module(adapter)
            server = object.__new__(adapter.GraphHopperProcess)
            server.port = 12345
            server.process = Mock()
            server.process.poll.side_effect = [None, 137]
            server.log_tail = Mock(return_value='java.lang.OutOfMemoryError: Java heap space')
            with patch.object(adapter.urllib.request, 'urlopen', side_effect=ConnectionResetError()), \
                 patch.object(adapter.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, r'exited with 137:[\s\S]*OutOfMemoryError'):
                    server.wait_ready()
