#!/usr/bin/env python3
"""Namespace and combine all GTFS ZIPs for the upstream ULTRA importer."""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import zipfile
from pathlib import Path


ID_COLUMNS = {
    "agency.txt": {"agency_id"},
    "stops.txt": {"stop_id", "parent_station"},
    "routes.txt": {"route_id", "agency_id"},
    "trips.txt": {"route_id", "service_id", "trip_id", "block_id"},
    "stop_times.txt": {"trip_id", "stop_id"},
    "calendar.txt": {"service_id"},
    "calendar_dates.txt": {"service_id"},
    "shapes.txt": {"shape_id"},
    "frequencies.txt": {"trip_id"},
    "transfers.txt": {"from_stop_id", "to_stop_id"},
    "pathways.txt": {"pathway_id", "from_stop_id", "to_stop_id"},
    "fare_attributes.txt": {"fare_id"},
    "fare_rules.txt": {"fare_id", "route_id", "origin_id", "destination_id", "contains_id"},
}
FILES = [
    "agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt",
    "calendar.txt", "calendar_dates.txt", "shapes.txt", "frequencies.txt",
    "transfers.txt", "pathways.txt", "levels.txt", "feed_info.txt",
    "fare_attributes.txt", "fare_rules.txt",
]


def member(archive: zipfile.ZipFile, filename: str) -> str | None:
    wanted = filename.lower()
    return next((name for name in archive.namelist() if Path(name).name.lower() == wanted), None)


def safe_prefix(index: int, feed: Path) -> str:
    stem = re.sub(r"[^A-Za-z0-9]+", "_", feed.stem).strip("_").lower() or "feed"
    return f"f{index:02d}_{stem}_"


def transform(filename: str, row: dict[str, str], prefix: str) -> dict[str, str]:
    if filename == "stops.txt":
        # ULTRA's numeric CSV parser rejects padding used by some GTFS feeds.
        # Preserve the coordinate text exactly apart from surrounding spaces.
        for key in ("stop_lat", "stop_lon"):
            if row.get(key) is not None:
                row[key] = row[key].strip()
    columns = ID_COLUMNS.get(filename, set())
    for key in columns:
        value = row.get(key, "")
        if value:
            row[key] = prefix + value
    return row


def process_file(feeds: list[Path], filename: str, output: Path) -> bool:
    first_header: list[str] | None = None
    for feed in feeds:
        with zipfile.ZipFile(feed) as archive:
            name = member(archive, filename)
            if name is None:
                continue
            with archive.open(name) as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
                reader = csv.DictReader(text)
                if first_header is None:
                    first_header = [str(value) for value in (reader.fieldnames or [])]
                    if not first_header:
                        continue
                    output.parent.mkdir(parents=True, exist_ok=True)
                    handle = output.open("w", encoding="utf-8", newline="")
                    writer = csv.DictWriter(handle, fieldnames=first_header, lineterminator="\n", extrasaction="ignore")
                    writer.writeheader()
                else:
                    handle = output.open("a", encoding="utf-8", newline="")
                    writer = csv.DictWriter(handle, fieldnames=first_header, lineterminator="\n", extrasaction="ignore")
                try:
                    for row in reader:
                        writer.writerow(transform(filename, row, safe_prefix(feeds.index(feed) + 1, feed)))
                finally:
                    handle.close()
    return first_header is not None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--feeds-json", required=True)
    args = parser.parse_args()
    feeds = [Path(value).resolve() for value in json.loads(args.feeds_json)]
    args.output.mkdir(parents=True, exist_ok=True)
    present = {filename for filename in FILES if process_file(feeds, filename, args.output / filename)}
    missing = {filename for filename in ("agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt") if filename not in present}
    if missing:
        raise RuntimeError(f"combined GTFS is missing required files: {', '.join(sorted(missing))}")
    print(json.dumps({"feeds": len(feeds), "files": sorted(present), "output": str(args.output)}))


if __name__ == "__main__":
    main()
