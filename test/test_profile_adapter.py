"""Reject same-length corruption in controlled HTTP measurements."""
import io
import json
from pathlib import Path
import runpy
import sys
import unittest

scripts = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(scripts))
fixture_response = runpy.run_path(str(scripts / 'profile-adapter-overhead.py'))['fixture_response']


class ProfileResponseTests(unittest.TestCase):
    def test_complete_body_is_verified(self):
        def response(body):
            return lambda _url: io.BytesIO(json.dumps(body).encode())
        self.assertEqual(fixture_response(response({'fixture': 'x' * 2048}), '/fixture'), 2048)
        for body in [{'fixture': 'y' * 2048}, {'fixture': 'x' * 2048, 'error': True}, {}]:
            with self.subTest(body_keys=list(body)), self.assertRaisesRegex(RuntimeError, 'content parity'):
                fixture_response(response(body), '/fixture')
