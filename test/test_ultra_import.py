import csv
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile


SCRIPTS = Path(__file__).parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('ultra_merge', SCRIPTS / 'ultra-gtfs-merge.py')
merge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merge)


class UltraImportTests(unittest.TestCase):
    def test_padded_coordinates_keep_values_and_stop_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            feed = root / 'transit.zip'
            with zipfile.ZipFile(feed, 'w') as archive:
                archive.writestr('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\n1,  Station,  40.578350 , -74.1  \n')
            output = root / 'stops.txt'
            self.assertTrue(merge.process_file([feed], 'stops.txt', output))
            with output.open() as handle:
                row = next(csv.DictReader(handle))
            self.assertEqual(row, dict(stop_id='f01_transit_1', stop_name='  Station',
                                       stop_lat='40.578350', stop_lon='-74.1'))

    @unittest.skipUnless(shutil.which('expect'), 'expect is not installed')
    def test_native_failure_is_not_success_at_eof(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'fake-network'
            for exit_code in (0, 7):
                with self.subTest(exit_code=exit_code):
                    binary.write_text(f'#!/bin/sh\nprintf "> "\nread command\nexit {exit_code}\n')
                    binary.chmod(0o700)
                    result = subprocess.run(['expect', str(SCRIPTS / 'ultra-run-script.tcl')],
                                            env={**os.environ, 'VIGO_ULTRA_BINARY':str(binary),
                                                 'VIGO_ULTRA_SCRIPT':'unused.script'},
                                            capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, exit_code, result.stdout)
