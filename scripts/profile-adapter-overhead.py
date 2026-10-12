#!/usr/bin/env python3
"""Controlled metadata and loopback HTTP overhead, without native routing."""
import argparse
import csv
import io
import json
from pathlib import Path
import socket
import statistics
import sys
import threading
import tracemalloc
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request
import zipfile
from adapter_runtime import agency_timezone, gtfs_rows, ResidentHttpClient


def uncached_timezone(feeds):
    for feed in feeds:
        with zipfile.ZipFile(feed) as archive:
            name = next((name for name in archive.namelist() if Path(name).name.lower() == 'agency.txt'), None)
            if name:
                for row in csv.DictReader(io.StringIO(archive.read(name).decode('utf-8-sig', errors='replace'))):
                    if (row.get('agency_timezone') or '').strip():
                        return row['agency_timezone'].strip()
    return None


def measure(call, count):
    times = []
    first = None
    for index in range(count):
        start = time.perf_counter()
        result = call()
        times.append((time.perf_counter() - start) * 1000)
        if index == 0:
            first = result
        elif result != first:
            raise RuntimeError('Response parity failed')
    ordered = sorted(times)
    return {'count': count, 'firstMs': times[0], 'medianMs': statistics.median(times),
            'totalMs': sum(times), 'p95Ms': ordered[max(0, int(count * .95 + .999999) - 1)], 'value': first}


def fixture_response(open_url, url):
    with open_url(url) as response:
        body = json.load(response)
    if body != {'fixture': 'x' * 2048}:
        raise RuntimeError('HTTP response content parity failed')
    return len(body['fixture'])


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.server.connections += 1
    def log_message(self, *args):
        pass
    def do_GET(self):
        payload = b'{"fixture":"' + b'x' * 2048 + b'"}'
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--count', type=int, default=1000)
    parser.add_argument('--feed', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.count < 1:
        parser.error('--count must be positive')
    feeds = (str(args.feed.resolve()),)
    agency_timezone.cache_clear()
    metadata = {'before': measure(lambda: uncached_timezone(feeds), args.count),
                'after': measure(lambda: agency_timezone(feeds), args.count)}
    if metadata['before']['value'] != metadata['after']['value']:
        raise RuntimeError('Timezone parity failed')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.connections = 0
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    client = ResidentHttpClient()
    url = f'http://127.0.0.1:{server.server_port}/fixture'
    try:
        http = {'before': measure(lambda: fixture_response(urllib.request.urlopen, url), args.count)}
        http['before']['connections'] = server.connections
        server.connections = 0
        http['after'] = measure(lambda: fixture_response(client.open, url), args.count)
        http['after']['connections'] = server.connections
        if http['before']['connections'] != args.count or http['after']['connections'] != 1:
            raise RuntimeError('HTTP connection reuse verification failed')
    finally:
        client.close()
        server.shutdown()
        server.server_close()
        worker.join()
    counts = {}
    for name, materialize in [('before', True), ('after', False)]:
        tracemalloc.start()
        start = time.perf_counter()
        with zipfile.ZipFile(args.feed) as archive:
            rows = gtfs_rows(archive, 'stop_times.txt')
            count = len(list(rows)) if materialize else sum(1 for _ in rows)
        elapsed = (time.perf_counter() - start) * 1000
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        counts[name] = {'rows': count, 'elapsedMs': elapsed, 'pythonPeakBytes': peak}
    if counts['before']['rows'] != counts['after']['rows']:
        raise RuntimeError('GTFS count parity failed')
    result = {'kind': 'synthetic-adapter-overhead', 'python': sys.version, 'feed': str(args.feed.resolve()),
              'limitation': 'Sequential loopback fixture with server TCP_NODELAY; no native routing. Metadata cache is not a route cache.',
              'metadata': metadata, 'http': http, 'gtfsCounting': counts}
    encoded = json.dumps(result, indent=2) + '\n'
    if args.output:
        with args.output.open('x') as output:
            output.write(encoded)
    print(encoded, end='')

if __name__ == '__main__':
    main()
