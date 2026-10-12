"""Resident adapter infrastructure; never caches routes or retries queries."""
from __future__ import annotations

import atexit
import csv
from functools import lru_cache
import http.client
import io
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
import zipfile


def gtfs_rows(archive, name):
    """Stream CSV rows while the archive and member remain open."""
    member = next((candidate for candidate in archive.namelist() if Path(candidate).name.lower() == name), None)
    if member is None:
        return
    with archive.open(member) as raw, io.TextIOWrapper(raw, encoding='utf-8-sig', newline='') as text:
        yield from csv.DictReader(text)


@lru_cache(maxsize=16)
def agency_timezone(feeds: tuple[str, ...]) -> str | None:
    """Feed metadata is immutable for one adapter process; first read stays lazy."""
    for feed in feeds:
        with zipfile.ZipFile(feed) as archive:
            member = next((name for name in archive.namelist() if Path(name).name.lower() == 'agency.txt'), None)
            if member is None:
                continue
            with archive.open(member) as raw, io.TextIOWrapper(raw, encoding='utf-8-sig', errors='replace', newline='') as text:
                for row in csv.DictReader(text):
                    zone = (row.get('agency_timezone') or '').strip()
                    if zone:
                        return zone
    return None


class ResidentHttpClient:
    """One serial loopback HTTP connection, with full response consumption.

    Reconnect on a later request after failure. Never retry a failed request:
    duplicate route execution would change the measured query contract.
    """
    def __init__(self):
        self._connection = None
        self._origin = None
        atexit.register(self.close)

    def close(self):
        if self._connection is not None:
            self._connection.close()
        self._connection = None
        self._origin = None

    def open(self, request):
        if isinstance(request, str):
            request = urllib.request.Request(request)
        url = urllib.parse.urlsplit(request.full_url)
        if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1'):
            raise ValueError('Adapter HTTP requests must target a loopback HTTP server')
        origin = (url.hostname, url.port or 80)
        if origin != self._origin:
            self.close()
            self._connection = http.client.HTTPConnection(*origin)
            self._origin = origin
        target = urllib.parse.urlunsplit(('', '', url.path or '/', url.query, ''))
        try:
            self._connection.request(request.get_method(), target, body=request.data, headers=dict(request.header_items()))
            response = self._connection.getresponse()
            with response:
                content = response.read()
            if response.status >= 300:
                raise urllib.error.HTTPError(request.full_url, response.status, response.reason, response.headers, io.BytesIO(content))
            return io.BytesIO(content)
        except urllib.error.HTTPError:
            raise
        except (OSError, http.client.HTTPException) as error:
            self.close()
            raise urllib.error.URLError(error) from error


def candidate_limit(context):
    """Bounded returned-candidate sensitivity; never an exhaustive-search claim."""
    value = context.get('comparison', {}).get('candidateLimit', 1)
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 20:
        raise ValueError('candidateLimit must be an integer from 1 to 20')
    return value
