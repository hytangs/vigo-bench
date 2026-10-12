#!/usr/bin/env python3
"""Built-in adapters for MOTIS, OTP, and Valhalla.

Each adapter consumes the same benchmark context: one OSM PBF and every GTFS
ZIP discovered in the city folder.  Preparation writes only engine-local
artifacts below the current engine work directory; query mode keeps the native
engine alive and answers the runner's one-request-per-line protocol.
"""

from __future__ import annotations

from adapter_runtime import candidate_limit, agency_timezone, gtfs_rows, ResidentHttpClient

HTTP = ResidentHttpClient()

import datetime as dt
import json
import math
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from otp_gtfs_compat import prepare_gtfs_paths_for_otp, service_period


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing {name}")
    return value


WORKDIR = Path(required("VIGO_BENCH_WORKDIR")).resolve()
OSM = Path(required("VIGO_BENCH_OSM_PBF")).resolve()
GTFS = [Path(value).resolve() for value in json.loads(required("VIGO_BENCH_GTFS_PATHS_JSON"))]
CONTEXT = json.loads(Path(required("VIGO_BENCH_CONTEXT")).read_text(encoding="utf-8"))
ENGINE = os.environ.get("VIGO_BENCH_ENGINE", "").strip()


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def write_log(name: str, stdout: str, stderr: str) -> None:
    (WORKDIR / f"{name}.stdout").write_text(stdout, encoding="utf-8")
    (WORKDIR / f"{name}.stderr").write_text(stderr, encoding="utf-8")


def run(command: list[str], *, cwd: Path = WORKDIR, name: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    write_log(name, result.stdout, result.stderr)
    if result.returncode:
        tail = (result.stderr or result.stdout)[-6000:]
        raise RuntimeError(f"{name} failed with exit {result.returncode}:\n{tail}")
    return result


def link(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    target.symlink_to(source)


def source_stats() -> dict[str, Any]:
    result = subprocess.run(
        ["osmium", "fileinfo", "--extended", "--json", str(OSM)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    data = json.loads(result.stdout).get("data", {})
    counts = data.get("count", {})
    return {
        "nodes": int(counts.get("nodes", 0)),
        "edges": int(counts.get("ways", 0)),
        "ways": int(counts.get("ways", 0)),
        "relations": int(counts.get("relations", 0)),
        "source": "OSM PBF nodes/ways; engine-native prepared graph counts replace these when exposed",
    }




def gtfs_stats() -> dict[str, int]:
    totals = {"stops": 0, "routes": 0, "trips": 0, "stopTimes": 0}
    members = {"stops": "stops.txt", "routes": "routes.txt", "trips": "trips.txt", "stopTimes": "stop_times.txt"}
    for feed in GTFS:
        with zipfile.ZipFile(feed) as archive:
            for key, filename in members.items():
                rows = gtfs_rows(archive, filename)
                totals[key] += sum(1 for _ in rows)
    totals["feeds"] = len(GTFS)
    return totals


def timezone_name() -> str | None:
    return agency_timezone(tuple(str(feed) for feed in GTFS))


def local_departure() -> str:
    value = f"{CONTEXT['serviceDate']}T{CONTEXT['time']}:00"
    zone = timezone_name()
    if not zone:
        return value
    try:
        local = dt.datetime.fromisoformat(value).replace(tzinfo=ZoneInfo(zone))
        return local.isoformat(timespec="seconds")
    except Exception:
        return value


def valhalla_departure() -> str:
    """Valhalla's date_time parser accepts local YYYY-MM-DDTHH:MM only."""
    return f"{CONTEXT['serviceDate']}T{CONTEXT['time']}"


def network_summary(*, street: dict[str, Any] | None = None, transit: dict[str, Any] | None = None) -> dict[str, Any]:
    base_street = {"nodes": None, "edges": None, "sourceObjects": source_stats()}
    if street:
        base_street.update(street)
    base_transit = gtfs_stats()
    if transit:
        base_transit.update(transit)
    return {"street": base_street, "transit": base_transit}


def prepare_motis() -> dict[str, Any]:
    binary = Path(os.environ.get("VIGO_BENCH_MOTIS_BINARY", "")).resolve()
    if not binary.exists():
        raise RuntimeError(f"MOTIS binary is missing: {binary}")
    source = WORKDIR / "source"
    source.mkdir(parents=True, exist_ok=True)
    osm = source / "network.osm.pbf"
    link(OSM, osm)
    feed_paths = []
    for index, feed in enumerate(GTFS, start=1):
        target = source / f"{index:02d}-{feed.stem}.gtfs.zip"
        link(feed, target)
        feed_paths.append(target)
    profile = Path(os.environ.get("VIGO_BENCH_MOTIS_ROOT", binary.parent)) / "tiles-profiles"
    if profile.exists():
        link(profile, WORKDIR / "tiles-profiles")
    run([str(binary), "config", str(osm), *(str(path) for path in feed_paths)], name="config")
    config_path = WORKDIR / "config.yml"
    config_text = config_path.read_text(encoding="utf-8")
    config_text = re.sub(r"(?m)^  first_day:\s*.*$", f"  first_day: {CONTEXT['serviceDate']}", config_text)
    config_text = re.sub(r"(?m)^geocoding:\s*true\s*$", "geocoding: false", config_text)
    config_text = re.sub(r"(?m)^reverse_geocoding:\s*true\s*$", "reverse_geocoding: false", config_text)
    config_text = re.sub(r"(?m)^osr_footpath:.*$", "osr_footpath: true", config_text)
    config_text = re.sub(r"(?m)^  default_transfer_time:.*$", "  default_transfer_time: 0", config_text)
    config_path.write_text(config_text, encoding="utf-8")
    stages = []
    for stage in ("tt", "osr", "tiles", "matches", "osr_footpath"):
        stages.append(run([str(binary), "import", "-c", "config.yml", "-d", "data", "--filter", stage], name=f"import-{stage}"))
    logs = "\n".join(result.stdout + result.stderr for result in stages)
    return {
        "status": "ready",
        "engine": ENGINE,
        "dataDirectory": str(WORKDIR / "data"),
        "network": network_summary(
            street={"source": "MOTIS osr import completed; native vertex/edge totals are not exposed"},
            transit={"source": "all GTFS ZIPs imported by MOTIS"},
        ),
        "native": {"version": version_of(binary), "importStages": ["tt", "osr", "tiles", "matches", "osr_footpath"], "logBytes": len(logs)},
    }


def prepare_otp() -> dict[str, Any]:
    jar = Path(required("VIGO_BENCH_OTP_JAR")).resolve()
    if not jar.exists():
        raise RuntimeError(f"OTP JAR is missing: {jar}")
    source = WORKDIR / "inputs"
    source.mkdir(parents=True, exist_ok=True)
    link(OSM, source / "network.osm.pbf")
    prepared_feeds, compatibility = prepare_gtfs_paths_for_otp(GTFS, WORKDIR / "gtfs-compatibility")
    for index, feed in enumerate(prepared_feeds, start=1):
        link(feed, source / f"{index:02d}-{feed.stem}.gtfs.zip")
    build_config = service_period(GTFS, CONTEXT['serviceDate'])
    (source / 'build-config.json').write_text(json.dumps(build_config, indent=2) + '\n')
    (source / "router-config.json").write_text(json.dumps({
        "routingDefaults": {
            "accessEgress": {"maxDuration": f"PT{endpoint_seconds()}S", "maxStopCount": 100000},
            "maxJourneyDuration": f"PT{comparison()['horizonMinutes']}M",
            "transferSlack": "PT0S", "boardSlack": "PT0S", "alightSlack": "PT0S",
            "itineraryFilters": {"debug": "LIST_ALL"},
        }
    }))
    heap = os.environ.get("VIGO_OTP_HEAP_GB", "8")
    build = run(["java", f"-Xmx{heap}G", "-jar", str(jar), "--build", "--save", str(source)], cwd=WORKDIR, name="otp-build")
    log = build.stdout + "\n" + build.stderr
    nodes = re.search(r"\|V\|=([\d,]+) \|E\|=([\d,]+)", log)
    transit = re.search(r"\|Stops\|=([\d,]+) \|Patterns\|=([\d,]+)", log)
    street = {}
    if nodes:
        street.update({"nodes": int(nodes.group(1).replace(",", "")), "edges": int(nodes.group(2).replace(",", "")), "source": "OTP graph.obj street graph"})
    transit_size = {}
    if transit:
        transit_size.update({"stops": int(transit.group(1).replace(",", "")), "tripPatterns": int(transit.group(2).replace(",", "")), "source": "OTP graph.obj transit graph"})
    return {
        "status": "ready",
        "engine": ENGINE,
        "graphDirectory": str(source),
        "network": network_summary(street=street, transit=transit_size),
        "gtfsCompatibility": compatibility,
        "servicePeriod": build_config,
        "native": {"version": version_of(jar), "graphBytes": (source / "graph.obj").stat().st_size},
    }


def valhalla_bin(python: Path, name: str) -> Path:
    result = subprocess.run([str(python), "-c", "import pathlib,valhalla; print(pathlib.Path(valhalla.__file__).resolve().parent / 'bin')"], text=True, stdout=subprocess.PIPE, check=True)
    return Path(result.stdout.strip()) / name


def prepare_valhalla() -> dict[str, Any]:
    python = Path(required("VIGO_BENCH_VALHALLA_PYTHON")).absolute()
    if not python.exists():
        raise RuntimeError(f"Valhalla Python is missing: {python}")
    data = WORKDIR / "data"
    tiles = data / "tiles"
    transit = data / "transit"
    feeds_root = data / "transit-feeds"
    for directory in (tiles, transit, feeds_root):
        directory.mkdir(parents=True, exist_ok=True)
    timezone = Path(required("VIGO_BENCH_VALHALLA_TIMEZONES")).resolve()
    if not timezone.exists():
        raise RuntimeError(f"Valhalla timezone database is missing: {timezone}")
    shutil.copyfile(timezone, data / "timezones.sqlite")
    for index, feed in enumerate(GTFS, start=1):
        destination = feeds_root / f"{index:02d}-{feed.stem}"
        destination.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(feed) as archive:
            for member in archive.infolist():
                if member.is_dir() or Path(member.filename).name.startswith("."):
                    continue
                target = destination / Path(member.filename).name
                with archive.open(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
    from valhalla.config import get_config
    config = get_config(tile_extract="", tile_dir=tiles)
    config["logging"]["type"] = ""
    config["mjolnir"].update({
        "tile_dir": str(tiles),
        "tile_extract": "",
        "admin": str(data / "admins.sqlite"),
        "timezone": str(data / "timezones.sqlite"),
        "transit_dir": str(transit),
        "transit_feeds_dir": str(feeds_root),
    })
    config["mjolnir"]["data_processing"]["use_admin_db"] = False
    config_path = data / "valhalla.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    jobs = os.environ.get("VIGO_VALHALLA_PREP_JOBS", str(max(1, os.cpu_count() or 1)))
    ingest = valhalla_bin(python, "valhalla_ingest_transit")
    convert = valhalla_bin(python, "valhalla_convert_transit")
    tiles_bin = valhalla_bin(python, "valhalla_build_tiles")
    run([str(ingest), "-c", str(config_path), "-j", jobs], cwd=data, name="valhalla-ingest-transit")
    run([str(convert), "-c", str(config_path), "-j", jobs], cwd=data, name="valhalla-convert-transit")
    run([str(tiles_bin), "-c", str(config_path), "-j", jobs, str(OSM)], cwd=data, name="valhalla-build-tiles")
    tile_bytes = sum(path.stat().st_size for path in tiles.rglob("*") if path.is_file())
    return {
        "status": "ready",
        "engine": ENGINE,
        "config": str(config_path),
        "network": network_summary(
            street={"source": "Valhalla imported OSM tiles; source object counts are reported because native graph totals are not exposed"},
            transit={"source": "all GTFS ZIPs ingested into Valhalla transit tiles"},
        ),
        "native": {"version": version_of(python), "tileBytes": tile_bytes, "transitTileDirectory": str(tiles / "3")},
    }


def version_of(command: Path) -> str | None:
    try:
        result = subprocess.run([str(command), "--version"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        line = next((line.strip() for line in result.stdout.splitlines() if line.strip()), None)
        return line
    except Exception:
        return None


def http_json(url: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with HTTP.open(request) as response:
            raw = response.read().decode()
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {error.code} from {url}: {detail[:2000]}") from error
    return json.loads(raw) if raw else {}


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_http(url: str, process: subprocess.Popen[str], *, method: str = "GET", body: dict[str, Any] | None = None) -> None:
    while True:
        if process.poll() is not None:
            raise RuntimeError(f"native server exited with code {process.returncode}")
        try:
            http_json(url, method=method, body=body)
            return
        except (urllib.error.URLError, ConnectionError, json.JSONDecodeError):
            time.sleep(0.05)


def stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def comparison() -> dict[str, Any]:
    return CONTEXT.get("comparison", {"maxTransfers": 3, "horizonMinutes": 240, "walkSpeedKph": 4.8})


def endpoint_seconds() -> int:
    return math.floor(float(CONTEXT["maxWalkKm"]) * 3600 / comparison()["walkSpeedKph"])


def motis_policy_violations(itinerary: dict[str, Any], duration: float) -> list[str]:
    legs = itinerary.get('legs', [])
    rides = [index for index, leg in enumerate(legs) if leg.get('mode') != 'WALK']
    violations = []
    if not rides:
        violations.append('transit_required')
    if int(itinerary.get('transfers', 0)) > comparison()['maxTransfers']:
        violations.append('transfer_cap_exceeded')
    if duration > comparison()['horizonMinutes']:
        violations.append('horizon_exceeded')
    for leg in legs:
        cancelled = any(value.get('cancelled') for value in (leg, leg.get('from') or {}, leg.get('to') or {}))
        if leg.get('mode') != 'WALK':
            if cancelled and 'cancelled_transit_leg' not in violations:
                violations.append('cancelled_transit_leg')
            continue
        # MOTIS emits cancelled WALK placeholders without distance when detailed
        # OSR recovery fails. They cannot establish the requested walking limits.
        if cancelled or leg.get('distance') is None:
            if 'walk_path_unresolved' not in violations:
                violations.append('walk_path_unresolved')
            continue
        seconds = (dt.datetime.fromisoformat(leg['endTime'].replace('Z', '+00:00')) - dt.datetime.fromisoformat(leg['startTime'].replace('Z', '+00:00'))).total_seconds()
        # MOTIS timestamps have minute precision. Retain that uncertainty,
        # but do not accept distances impossible even within that tolerance.
        if seconds + 60 < float(leg['distance']) / (comparison()['walkSpeedKph'] / 3.6):
            violations.append('walk_faster_than_common_speed')
            break
    if rides:
        for role, part in [('access', legs[:rides[0]]), ('egress', legs[rides[-1] + 1:])]:
            if all(leg.get('distance') is not None for leg in part) and sum(float(leg['distance']) for leg in part) > float(CONTEXT['maxWalkKm']) * 1000:
                violations.append(f'{role}_walk_budget_exceeded')
    return violations


def motis_query(request: dict[str, Any], base_url: str) -> dict[str, Any]:
    origin = request["origin"]["coordinate"]
    destination = request["destination"]["coordinate"]
    query = {
        "fromPlace": f"{origin[1]},{origin[0]}",
        "toPlace": f"{destination[1]},{destination[0]}",
        "time": local_departure(),
        "arriveBy": "false",
        "transitModes": "TRANSIT",
        "directModes": "",
        "pedestrianSpeed": str(comparison()["walkSpeedKph"] / 3.6),
        "minTransferTime": "0",
        "additionalTransferTime": "0",
        "useRoutedTransfers": "true",
        "detailedTransfers": "true",
        "preTransitModes": "WALK",
        "postTransitModes": "WALK",
        "maxPreTransitTime": str(endpoint_seconds()),
        "maxPostTransitTime": str(endpoint_seconds()),
        "maxDirectTime": "0",
        "maxTravelTime": str(comparison()["horizonMinutes"]),
        "maxTransfers": str(comparison()["maxTransfers"]),
        "numItineraries": str(candidate_limit(CONTEXT)),
        "searchWindow": "0",
        # A fixed depart-at benchmark includes initial waiting. An empty
        # timetable window with numItineraries=1 is still a profile query.
        "timetableView": "false",
    }
    started = time.perf_counter()
    payload = http_json(f"{base_url}/api/v6/plan?{urllib.parse.urlencode(query)}")
    elapsed = (time.perf_counter() - started) * 1000
    if not isinstance(payload, dict) or not any(key in payload for key in ("itineraries", "direct")):
        raise RuntimeError("MOTIS response omitted itinerary arrays")
    if any(not isinstance(payload.get(key, []), list) for key in ("itineraries", "direct")):
        raise RuntimeError("MOTIS response contains an invalid itinerary array")
    candidates = payload.get("itineraries", []) + payload.get("direct", [])
    if any(not isinstance(candidate, dict) for candidate in candidates):
        raise RuntimeError("MOTIS response contains an invalid itinerary")
    diagnostics = {"algorithm": "MOTIS native point query", "walkingNetwork": "osm",
                   "timetableView": False, "requestedCandidateLimit": candidate_limit(CONTEXT), "nativeCandidateCount": len(candidates),
                   "selectionScope": "earliest arrival among returned candidates passing adapter checks; global optimality unproven"}
    if not candidates:
        return {"id": request["id"], "status": "blocked", "queryMs": elapsed, "detail": "MOTIS returned no itinerary.",
                "plan": {"status": "blocked", "diagnostics": {**diagnostics, "outcomeReason": "native_no_itinerary"}}}
    departure = dt.datetime.fromisoformat(local_departure())
    evaluated = []
    for index, itinerary in enumerate(candidates):
        arrival = dt.datetime.fromisoformat(itinerary['endTime'].replace('Z', '+00:00'))
        duration = (arrival - departure).total_seconds() / 60
        evaluated.append({"nativeIndex": index, "itinerary": itinerary, "arrival": arrival,
                          "durationMinutes": duration, "policyViolations": motis_policy_violations(itinerary, duration)})
    evaluated.sort(key=lambda candidate: candidate['arrival'])
    passing = [candidate for candidate in evaluated if not candidate['policyViolations']]
    diagnostics.update({"policyPassingCandidateCount": len(passing),
                        "nativeCandidateRejections": [
                            {"nativeIndex": candidate['nativeIndex'], "endTime": candidate['itinerary']['endTime'],
                             "policyViolations": candidate['policyViolations']}
                            for candidate in evaluated if candidate['policyViolations']]})
    if not passing:
        earliest = evaluated[0]
        return {"id": request["id"], "status": "blocked", "queryMs": elapsed,
                "detail": "Every returned MOTIS candidate violates requested controls; no further native search was run.",
                "rejectedItinerary": earliest['itinerary'],
                "plan": {"status": "blocked", "diagnostics": {**diagnostics,
                    "outcomeReason": "native_candidate_rejected", "policyViolations": earliest['policyViolations'], "unreachabilityProven": False}}}
    selected = passing[0]
    itinerary = selected['itinerary']
    diagnostics['selectedNativeIndex'] = selected['nativeIndex']
    return {"id": request["id"], "status": "ready", "queryMs": elapsed, "itinerary": itinerary,
            "plan": {"status": "ready", "durationMinutes": selected['durationMinutes'],
                     "transfers": int(itinerary.get("transfers", 0)), "diagnostics": diagnostics}}


def otp_query(request: dict[str, Any], base_url: str) -> dict[str, Any]:
    origin = request["origin"]["coordinate"]
    destination = request["destination"]["coordinate"]
    departure = local_departure()
    query = f'''query VigoBenchmarkPlan {{
      planConnection(
        origin: {{ location: {{ coordinate: {{ latitude: {float(origin[1])}, longitude: {float(origin[0])} }} }} }}
        destination: {{ location: {{ coordinate: {{ latitude: {float(destination[1])}, longitude: {float(destination[0])} }} }} }}
        dateTime: {{ earliestDeparture: "{departure}" }}
        searchWindow: "PT0S"
        first: {candidate_limit(CONTEXT)}
        modes: {{ direct: [WALK], transitOnly: true, transit: {{ access: [WALK], egress: [WALK], transfer: [WALK] }} }}
        preferences: {{ street: {{ walk: {{ speed: {comparison()["walkSpeedKph"] / 3.6}, reluctance: 1, boardCost: 0, safetyFactor: 0 }} }}, transit: {{ board: {{ slack: "PT0S", waitReluctance: 1 }}, alight: {{ slack: "PT0S" }}, transfer: {{ slack: "PT0S", cost: 0, maximumTransfers: {comparison()["maxTransfers"]} }} }} }}
      ) {{ edges {{ node {{ duration start end numberOfTransfers walkTime walkDistance waitingTime legs {{ mode distance duration start {{ scheduledTime }} end {{ scheduledTime }} from {{ name lat lon stop {{ gtfsId }} }} to {{ name lat lon stop {{ gtfsId }} }} trip {{ gtfsId }} route {{ gtfsId shortName }} legGeometry {{ points length }} interlineWithPreviousLeg }} }} }} }}
    }}'''
    started = time.perf_counter()
    payload = http_json(f"{base_url}/otp/gtfs/v1", method="POST", body={"query": query})
    elapsed = (time.perf_counter() - started) * 1000
    if not isinstance(payload, dict):
        raise RuntimeError("OTP returned a non-object response")
    if payload.get("errors"):
        raise RuntimeError(json.dumps(payload["errors"], separators=(",", ":")))
    data = payload.get("data")
    connection = data.get("planConnection") if isinstance(data, dict) else None
    edges = connection.get("edges") if isinstance(connection, dict) else None
    if not isinstance(edges, list) or any(not isinstance(edge, dict) or not isinstance(edge.get("node"), dict) for edge in edges):
        raise RuntimeError("OTP response omitted valid planConnection edges")
    native_candidates = [edge["node"] for edge in edges]
    evaluated = []
    for index, itinerary in enumerate(native_candidates):
        legs = itinerary.get('legs')
        if not isinstance(legs, list) or not legs:
            raise RuntimeError('OTP candidate omitted legs')
        duration = (dt.datetime.fromisoformat(itinerary['end'].replace('Z', '+00:00')) - dt.datetime.fromisoformat(departure)).total_seconds() / 60
        if not math.isfinite(duration) or duration < 0:
            raise RuntimeError('OTP candidate has invalid arrival time')
        rides = [i for i, leg in enumerate(legs) if leg.get('mode') not in (None, 'WALK')]
        violations = []
        if not rides:
            violations.append('transit_required')
        if int(itinerary.get('numberOfTransfers', 0)) > comparison()['maxTransfers']:
            violations.append('transfer_cap_exceeded')
        if duration > comparison()['horizonMinutes']:
            violations.append('horizon_exceeded')
        if rides:
            for role, part in [('access', legs[:rides[0]]), ('egress', legs[rides[-1]+1:])]:
                if any(leg.get('distance') is None for leg in part):
                    violations.append(f'{role}_walk_distance_unreported')
                elif sum(float(leg['distance']) for leg in part) > float(CONTEXT['maxWalkKm']) * 1000:
                    violations.append(f'{role}_walk_budget_exceeded')
        evaluated.append((duration, index, itinerary, violations))
    evaluated.sort(key=lambda item: item[0])
    passing = [item for item in evaluated if not item[3]]
    diagnostics = {'algorithm': 'OTP GraphQL planConnection', 'walkingNetwork': 'osm',
                   'requestedCandidateLimit': candidate_limit(CONTEXT), 'nativeCandidateCount': len(evaluated),
                   'policyPassingCandidateCount': len(passing), 'unreachabilityProven': False,
                   'nativeWalkOnlyCandidates': sum('transit_required' in item[3] for item in evaluated),
                   'selectionScope': 'earliest arrival among returned candidates passing adapter checks; global optimality unproven',
                   'nativeCandidateRejections': [{'nativeIndex': i, 'policyViolations': v} for _, i, _, v in evaluated if v]}
    if not passing:
        diagnostics['outcomeReason'] = 'native_candidate_rejected' if evaluated else 'native_no_itinerary'
        return {'id': request['id'], 'status': 'blocked', 'queryMs': elapsed,
                'detail': 'No returned OTP candidate passes the requested controls; no further native search was run.',
                'rejectedItinerary': evaluated[0][2] if evaluated else None,
                'rejectedItineraries': [item[2] for item in evaluated],
                'plan': {'status': 'blocked', 'diagnostics': diagnostics}}
    duration, index, itinerary, _ = passing[0]
    diagnostics['selectedNativeIndex'] = index
    return {'id': request['id'], 'status': 'ready', 'queryMs': elapsed, 'itinerary': itinerary,
            'plan': {'status': 'ready', 'durationMinutes': duration,
                     'transfers': int(itinerary.get('numberOfTransfers', 0)), 'diagnostics': diagnostics}}


def native_stdout(callable_object):
    sys.stdout.flush()
    saved = os.dup(sys.stdout.fileno())
    try:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        return callable_object()
    finally:
        sys.stdout.flush()
        os.dup2(saved, sys.stdout.fileno())
        os.close(saved)


def valhalla_query(request: dict[str, Any], actor: Any) -> dict[str, Any]:
    origin = request["origin"]["coordinate"]
    destination = request["destination"]["coordinate"]
    max_walk = float(CONTEXT["maxWalkKm"]) * 1000
    options = {
        "locations": [{"lat": float(origin[1]), "lon": float(origin[0]), "type": "break"}, {"lat": float(destination[1]), "lon": float(destination[0]), "type": "break"}],
        "costing": "multimodal",
        "date_time": {"type": 1, "value": valhalla_departure()},
        "costing_options": {"pedestrian": {"walking_speed": comparison()["walkSpeedKph"], "multimodal_start_end_max_distance": max_walk, "transit_transfer_max_distance": max_walk}, "transit": {"use_bus": 1.0, "use_rail": 1.0, "use_transfers": 0.5}},
        "directions_options": {"units": "kilometers"},
    }
    started = time.perf_counter()
    try:
        payload = native_stdout(lambda: actor.route(options))
    except Exception as error:
        elapsed = (time.perf_counter() - started) * 1000
        detail = str(error)
        if ("No path could be found" in detail
                or "No route could be found" in detail
                or "Locations are in unconnected regions" in detail
                or "No suitable edges near location" in detail
                or "Cannot reach destination - too far from a transit stop" in detail):
            return {"id": request["id"], "status": "blocked", "queryMs": elapsed, "detail": detail, "plan": {"status": "blocked", "diagnostics": {"algorithm": "Valhalla multimodal", "walkingNetwork": "osm"}}}
        raise
    elapsed = (time.perf_counter() - started) * 1000
    trip = payload.get("trip") if isinstance(payload, dict) else None
    summary = trip.get("summary") if isinstance(trip, dict) else None
    if not isinstance(summary, dict):
        raise RuntimeError("Valhalla response omitted the trip summary")
    duration = summary.get("time")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
        raise RuntimeError("Valhalla response omitted a valid trip duration")
    maneuvers = [maneuver for leg in payload.get("trip", {}).get("legs", []) for maneuver in leg.get("maneuvers", [])]
    transit = [maneuver for maneuver in maneuvers if maneuver.get("travel_mode") == "transit"]
    # Multimodal can return a direct walk and its native endpoint limits do
    # not guarantee the benchmark's per-endpoint walking budget. Retain a
    # rejected native candidate explicitly; this is not proof of no route.
    if not maneuvers:
        raise RuntimeError("Valhalla response omitted route maneuvers")
    violations = []
    if not transit:
        violations.append("transit_required")
    else:
        ride_indices = [i for i, maneuver in enumerate(maneuvers) if maneuver.get("travel_mode") == "transit"]
        for role, part in [("access", maneuvers[:ride_indices[0]]), ("egress", maneuvers[ride_indices[-1] + 1:])]:
            lengths = [maneuver.get("length") for maneuver in part]
            if any(isinstance(length, bool) or not isinstance(length, (int, float)) or not math.isfinite(length) or length < 0 for length in lengths):
                raise RuntimeError("Valhalla response omitted valid walking distances")
            if sum(lengths) * 1000 > max_walk:
                violations.append(f"{role}_walk_budget_exceeded")
    if len(transit) - 1 > comparison()["maxTransfers"]:
        violations.append("transfer_cap_exceeded")
    if duration > comparison()["horizonMinutes"] * 60:
        violations.append("horizon_exceeded")
    if violations:
        return {"id": request["id"], "status": "blocked", "queryMs": elapsed,
                "detail": "Valhalla native candidate violates requested controls; alternatives were not searched.",
                "rejectedItinerary": trip,
                "plan": {"status": "blocked", "diagnostics": {"algorithm": "Valhalla multimodal", "walkingNetwork": "osm",
                    "outcomeReason": "native_candidate_rejected", "policyViolations": violations, "unreachabilityProven": False}}}
    return {"id": request["id"], "status": "ready", "queryMs": elapsed, "itinerary": payload.get("trip"), "plan": {"status": "ready", "durationMinutes": float(duration) / 60, "transfers": max(0, len(transit) - 1), "diagnostics": {"algorithm": "Valhalla multimodal", "walkingNetwork": "osm"}}}


def serve_requests(route, process=None) -> None:
    """Retain one error response per failed query while a server remains alive."""
    for line in sys.stdin:
        if not line.strip():
            continue
        request = None
        started = time.perf_counter()
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("benchmark request must be a JSON object")
            payload = route(request)
        except Exception as error:
            payload = {"id": request.get("id") if isinstance(request, dict) else None,
                       "status": "error", "queryMs": (time.perf_counter() - started) * 1000,
                       "error": str(error)}
        emit(payload)
        if process is not None and process.poll() is not None:
            raise RuntimeError(f"native server exited with code {process.returncode}")


def motis_server_config(text: str, port: int) -> str:
    """Override only server binding in MOTIS' generated block-style YAML."""
    lines = text.splitlines(keepends=True)
    starts = [index for index, line in enumerate(lines) if re.match(r"^server\s*:", line)]
    if not starts:
        return text.rstrip() + f'\nserver:\n  host: "127.0.0.1"\n  port: {port}\n'
    if len(starts) != 1 or not re.match(r"^server\s*:\s*(?:#.*)?$", lines[starts[0]].rstrip()):
        raise RuntimeError("MOTIS server configuration must be a single block-style YAML mapping")
    start = starts[0]
    end = start + 1
    while end < len(lines) and (not lines[end].strip() or lines[end].startswith((" ", "\t", "#"))):
        end += 1
    block = lines[start + 1:end]
    indentation = next((match.group(1) for line in block if (match := re.match(r"^( +)\S", line))), "  ")
    binding = re.compile(rf"^{re.escape(indentation)}(?:host|port)\s*:")
    kept = "".join(line for line in block if not binding.match(line)).rstrip()
    if kept:
        kept += "\n"
    replacement = f'{lines[start].rstrip()}\n{kept}{indentation}host: "127.0.0.1"\n{indentation}port: {port}\n'
    return "".join(lines[:start]) + replacement + "".join(lines[end:])


def query_motis() -> None:
    binary = Path(required("VIGO_BENCH_MOTIS_BINARY")).resolve()
    port = free_port()
    data = WORKDIR / "data"
    # The server has no CLI binding flags. A temporary data view lets us alter
    # its binding without rewriting any retained graph or imported config.
    with tempfile.TemporaryDirectory(prefix=".motis-server-", dir=WORKDIR) as temporary:
        server_data = Path(temporary)
        for entry in data.iterdir():
            if entry.name != "config.yml":
                (server_data / entry.name).symlink_to(entry.resolve(), target_is_directory=entry.is_dir())
        (server_data / "config.yml").write_text(motis_server_config((data / "config.yml").read_text(encoding="utf-8"), port), encoding="utf-8")
        with (WORKDIR / "server.stdout").open("w", encoding="utf-8") as stdout_log, \
             (WORKDIR / "server.stderr").open("w", encoding="utf-8") as stderr_log:
            process = subprocess.Popen([str(binary), "server", "-d", str(server_data), "--log-level", "error"], cwd=WORKDIR, stdout=stdout_log, stderr=stderr_log, text=True)
            try:
                wait_http(f"http://127.0.0.1:{port}/api/v1/health", process)
                serve_requests(lambda request: motis_query(request, f"http://127.0.0.1:{port}"), process)
            finally:
                stop_process(process)


def query_otp() -> None:
    jar = Path(required("VIGO_BENCH_OTP_JAR")).resolve()
    port = free_port()
    stdout_log = (WORKDIR / "server.stdout").open("w", encoding="utf-8")
    stderr_log = (WORKDIR / "server.stderr").open("w", encoding="utf-8")
    process = subprocess.Popen(["java", "-Xmx8G", "-jar", str(jar), "--load", "--serve", "--bindAddress", "127.0.0.1", "--port", str(port), str(WORKDIR / "inputs")], cwd=WORKDIR, stdout=stdout_log, stderr=stderr_log, text=True)
    try:
        wait_http(f"http://127.0.0.1:{port}/otp/gtfs/v1", process, method="POST", body={"query": "query { __typename }"})
        serve_requests(lambda request: otp_query(request, f"http://127.0.0.1:{port}"), process)
    finally:
        stop_process(process)
        stdout_log.close()
        stderr_log.close()


def query_valhalla() -> None:
    python = Path(required("VIGO_BENCH_VALHALLA_PYTHON")).absolute()
    import valhalla
    actor = native_stdout(lambda: valhalla.Actor(str(WORKDIR / "data" / "valhalla.json")))
    serve_requests(lambda request: valhalla_query(request, actor))


def main() -> None:
    WORKDIR.mkdir(parents=True, exist_ok=True)
    phase = os.environ.get("VIGO_BENCH_PHASE", "")
    if phase == "prepare":
        if ENGINE == "MOTIS":
            emit(prepare_motis())
        elif ENGINE == "OTP":
            emit(prepare_otp())
        elif ENGINE == "Valhalla":
            emit(prepare_valhalla())
        else:
            raise RuntimeError(f"unsupported native engine {ENGINE}")
    elif phase == "query":
        if ENGINE == "MOTIS":
            query_motis()
        elif ENGINE == "OTP":
            query_otp()
        elif ENGINE == "Valhalla":
            query_valhalla()
        else:
            raise RuntimeError(f"unsupported native engine {ENGINE}")
    else:
        raise RuntimeError("VIGO_BENCH_PHASE must be prepare or query")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
