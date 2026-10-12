"""Prepare an explicit R5 v7.4 compatibility copy of GTFS transfers.

R5 v7.4 loads only the four legacy stop-to-stop transfer fields and validates
transfer_type against the 0--3 range. Scoped rows are omitted rather than
incorrectly broadened. Current type-4 in-seat rows are omitted only when R5's
own block_id interlining represents the same trip continuity.
"""

from __future__ import annotations

import csv
import hashlib
import io
import os
import zipfile
from collections import Counter
from pathlib import Path


R5_TRANSFER_TYPES = {"", "0", "1", "2", "3"}
R5_TRANSFER_FIELDS = ["from_stop_id", "to_stop_id", "transfer_type", "min_transfer_time"]
TRANSFER_SCOPE_FIELDS = ["from_route_id", "to_route_id", "from_trip_id", "to_trip_id"]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def csv_rows(archive: zipfile.ZipFile, name: str) -> tuple[list[str], list[dict[str, str]]]:
    with archive.open(name) as stream:
        reader = csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig", newline=""))
        if reader.fieldnames is None:
            raise ValueError(f"{name} has no CSV header")
        return list(reader.fieldnames), list(reader)


def named_entry(archive: zipfile.ZipFile, basename: str) -> str | None:
    matches = [name for name in archive.namelist() if Path(name).name.lower() == basename.lower()]
    if len(matches) > 1:
        raise ValueError(f"GTFS archive has multiple {basename} entries")
    return matches[0] if matches else None


def prepare_gtfs_for_r5(source: Path, output_directory: Path) -> tuple[Path, dict]:
    source = source.resolve()
    report = {
        "source": str(source),
        "sourceSha256": sha256(source),
        "modified": False,
        "reason": "R5 v7.4 loads unscoped transfer_type 0-3 rows; scoped rows are omitted rather than broadened, and safe type-4 in-seat rows are represented through block_id interlining.",
    }
    with zipfile.ZipFile(source) as archive:
        transfers_name = named_entry(archive, "transfers.txt")
        if transfers_name is None:
            report["transfers"] = {"present": False, "originalRows": 0, "retainedRows": 0, "removedRows": 0}
            return source, report
        fields, transfers = csv_rows(archive, transfers_name)
        if "transfer_type" not in fields:
            report["transfers"] = {"present": True, "originalRows": len(transfers), "retainedRows": len(transfers), "removedRows": 0}
            return source, report

        modern = [row for row in transfers if row.get("transfer_type", "").strip() not in R5_TRANSFER_TYPES]
        scoped = [
            row
            for row in transfers
            if row.get("transfer_type", "").strip() in R5_TRANSFER_TYPES
            and any(row.get(field, "").strip() for field in TRANSFER_SCOPE_FIELDS)
        ]
        if not modern and not scoped:
            report["transfers"] = {"present": True, "originalRows": len(transfers), "retainedRows": len(transfers), "removedRows": 0}
            return source, report

        unsupported_types = sorted({row.get("transfer_type", "").strip() for row in modern} - {"4"})
        if unsupported_types:
            raise ValueError(
                f"R5 cannot safely normalize transfer_type value(s) {', '.join(unsupported_types)} in {source.name}"
            )

        trips_name = named_entry(archive, "trips.txt")
        if trips_name is None:
            raise ValueError(f"R5 compatibility check requires trips.txt in {source.name}")
        _, trips = csv_rows(archive, trips_name)
        blocks = {row.get("trip_id", ""): row.get("block_id", "").strip() for row in trips}
        unsafe = []
        for row in modern:
            from_trip = row.get("from_trip_id", "").strip()
            to_trip = row.get("to_trip_id", "").strip()
            from_block = blocks.get(from_trip, "")
            to_block = blocks.get(to_trip, "")
            if not from_trip or not to_trip or not from_block or from_block != to_block:
                unsafe.append((from_trip, to_trip))
        if unsafe:
            examples = ", ".join(f"{left}->{right}" for left, right in unsafe[:3])
            raise ValueError(
                f"R5 cannot safely omit {len(unsafe)} type-4 transfer row(s) without matching non-empty block_id values: {examples}"
            )

        retained = [
            row
            for row in transfers
            if row.get("transfer_type", "").strip() in R5_TRANSFER_TYPES
            and not any(row.get(field, "").strip() for field in TRANSFER_SCOPE_FIELDS)
        ]
        buffer = io.StringIO(newline="")
        writer = csv.DictWriter(buffer, fieldnames=R5_TRANSFER_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows({field: row.get(field, "") for field in R5_TRANSFER_FIELDS} for row in retained)
        transfer_bytes = buffer.getvalue().encode("utf-8")

        output_directory.mkdir(parents=True, exist_ok=True)
        destination = output_directory / f"{source.stem}.r5-compatible.zip"
        temporary = output_directory / f".{destination.name}.{os.getpid()}.tmp"
        try:
            with zipfile.ZipFile(temporary, "w") as target:
                for entry in archive.infolist():
                    target.writestr(entry, transfer_bytes if entry.filename == transfers_name else archive.read(entry.filename))
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)

    removed = modern + scoped
    removed_by_type = Counter(row.get("transfer_type", "").strip() for row in removed)
    report.update(
        {
            "modified": True,
            "compatiblePath": str(destination),
            "compatibleSha256": sha256(destination),
            "transfers": {
                "present": True,
                "originalRows": len(transfers),
                "retainedRows": len(retained),
                "removedRows": len(removed),
                "removedByType": dict(sorted(removed_by_type.items())),
                "safeSameBlockInSeatRows": len(modern),
                "unsupportedScopedRows": len(scoped),
                "outputFields": R5_TRANSFER_FIELDS,
            },
        }
    )
    return destination, report


def prepare_gtfs_paths_for_r5(sources: list[Path], output_directory: Path) -> tuple[list[Path], list[dict]]:
    prepared = [prepare_gtfs_for_r5(source, output_directory) for source in sources]
    return [path for path, _ in prepared], [report for _, report in prepared]
