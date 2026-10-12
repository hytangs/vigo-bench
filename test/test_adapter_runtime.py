"""Real loopback transport tests; no native routing performance claims."""
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))
from adapter_runtime import ResidentHttpClient, agency_timezone, gtfs_rows


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.server.connections += 1
    def log_message(self, *args):
        pass
    def do_GET(self):
        self.server.requests += 1
        if self.path == '/drop':
            self.close_connection = True
            return
        payload = json.dumps({'path': self.path, 'body': self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()}).encode()
        self.send_response(500 if self.path == '/error' else 200)
        self.send_header('Content-Length', str(len(payload)))
        if self.path == '/close':
            self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(payload)
    do_POST = do_GET


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.connections = self.server.requests = 0
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.client = ResidentHttpClient()
    def tearDown(self):
        self.client.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
    def test_keepalive_full_bodies_and_http_errors(self):
        for index in range(3):
            with self.client.open(self.url + f'/{index}') as response:
                self.assertEqual(json.load(response)['path'], f'/{index}')
        request = urllib.request.Request(self.url + '/post', data=b'complete request', method='POST')
        with self.client.open(request) as response:
            self.assertEqual(json.load(response)['body'], 'complete request')
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.client.open(self.url + '/error')
        self.assertEqual(error.exception.code, 500)
        self.assertEqual(json.load(error.exception)['path'], '/error')
        self.client.open(self.url + '/after').close()
        self.assertEqual(self.server.connections, 1)
    def test_server_close_and_failure_do_not_replay_queries(self):
        self.client.open(self.url + '/close').close()
        self.client.open(self.url + '/second').close()
        with self.assertRaises(urllib.error.URLError):
            self.client.open(self.url + '/drop')
        self.assertEqual(self.server.requests, 3)
        self.client.open(self.url + '/recovered').close()
        self.assertEqual(self.server.requests, 4)
        self.assertEqual(self.server.connections, 3)
    def test_timezone_read_once_per_feed_population(self):
        agency_timezone.cache_clear()
        with tempfile.TemporaryDirectory() as root:
            feed = Path(root) / 'feed.zip'
            with zipfile.ZipFile(feed, 'w') as archive:
                archive.writestr('nested/agency.txt', 'agency_timezone\nAmerica/New_York\n')
            with patch('adapter_runtime.zipfile.ZipFile', wraps=zipfile.ZipFile) as opened:
                for _ in range(3):
                    self.assertEqual(agency_timezone((str(feed),)), 'America/New_York')
                self.assertEqual(opened.call_count, 1)
        self.assertIsNone(agency_timezone(()))


class FeedStreamingTests(unittest.TestCase):
    def test_streaming_preserves_csv_records_and_missing_members(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            archive.writestr('nested/STOP_TIMES.TXT', '\ufefftrip_id,stop_id\n"trip,1","stop\nname"\ntrip2,stop2\n')
        data.seek(0)
        with zipfile.ZipFile(data) as archive:
            self.assertEqual(list(gtfs_rows(archive, 'stop_times.txt')), [
                {'trip_id': 'trip,1', 'stop_id': 'stop\nname'}, {'trip_id': 'trip2', 'stop_id': 'stop2'}])
            self.assertEqual(list(gtfs_rows(archive, 'missing.txt')), [])
