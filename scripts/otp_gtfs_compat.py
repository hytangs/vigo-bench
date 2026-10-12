"""Prepare strict-CSV compatibility copies of GTFS feeds for OTP.

OTP's OneBusAway CSV reader rejects horizontal padding between the closing
quote of a field and the following delimiter or record ending. Some otherwise
usable feeds contain this padding. The source archive is never modified; only
the invalid exterior padding is removed in an engine-local copy.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import os
import zipfile
from pathlib import Path


def service_period(sources: list[Path], service_date: str) -> dict[str, str]:
    """Freeze OTP's import period to source calendars and the requested date."""
    dates = {dt.date.fromisoformat(service_date)}
    for source in sources:
        with zipfile.ZipFile(source) as archive:
            for member in archive.namelist():
                name = Path(member).name.lower()
                fields = ('start_date', 'end_date') if name == 'calendar.txt' else ('date',) if name == 'calendar_dates.txt' else ()
                if not fields:
                    continue
                with archive.open(member) as raw:
                    for row in csv.DictReader(io.TextIOWrapper(raw, encoding='utf-8-sig', newline='')):
                        for field in fields:
                            if row.get(field):
                                dates.add(dt.datetime.strptime(row[field].strip(), '%Y%m%d').date())
    return {'transitServiceStart': min(dates).isoformat(), 'transitServiceEnd': max(dates).isoformat()}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_post_quote_padding(data: bytes) -> tuple[bytes, int, int]:
    """Remove only spaces or tabs outside a closed quoted CSV field."""
    output = bytearray()
    in_quoted_field = False
    at_field_start = True
    affected_fields = 0
    removed_bytes = 0
    index = 0

    while index < len(data):
        byte = data[index]
        if in_quoted_field:
            output.append(byte)
            if byte == ord('"'):
                if index + 1 < len(data) and data[index + 1] == ord('"'):
                    output.append(data[index + 1])
                    index += 2
                    continue
                in_quoted_field = False
                following = index + 1
                while following < len(data) and data[following] in (ord(" "), ord("\t")):
                    following += 1
                if following > index + 1 and (
                    following == len(data) or data[following] in (ord(","), ord("\r"), ord("\n"))
                ):
                    affected_fields += 1
                    removed_bytes += following - index - 1
                    index = following
                    continue
            index += 1
            continue

        output.append(byte)
        if at_field_start and byte == ord('"'):
            in_quoted_field = True
            at_field_start = False
        elif byte in (ord(","), ord("\r"), ord("\n")):
            at_field_start = True
        else:
            at_field_start = False
        index += 1

    return bytes(output), affected_fields, removed_bytes


def validate_normalization(original: bytes, normalized: bytes, member: str) -> None:
    before = list(csv.reader(io.TextIOWrapper(io.BytesIO(original), encoding="utf-8-sig", newline="")))
    after = list(
        csv.reader(
            io.TextIOWrapper(io.BytesIO(normalized), encoding="utf-8-sig", newline=""),
            strict=True,
        )
    )
    if len(before) != len(after) or any(len(left) != len(right) for left, right in zip(before, after)):
        raise ValueError(f"OTP CSV normalization changed the row or field structure of {member}")
    for left, right in zip(before, after):
        for original_value, normalized_value in zip(left, right):
            if original_value != normalized_value and original_value.rstrip(" \t") != normalized_value:
                raise ValueError(f"OTP CSV normalization changed content inside a field in {member}")


def prepare_gtfs_for_otp(source: Path, output_directory: Path) -> tuple[Path, dict]:
    source = source.resolve()
    report = {
        "source": str(source),
        "sourceSha256": sha256(source),
        "modified": False,
        "reason": "OTP requires no spaces or tabs after a quoted CSV field and before its delimiter or record ending.",
    }
    replacements: dict[str, bytes] = {}
    files: list[dict] = []

    with zipfile.ZipFile(source) as archive:
        for entry in archive.infolist():
            if entry.is_dir() or not entry.filename.lower().endswith(".txt"):
                continue
            original = archive.read(entry.filename)
            normalized, affected_fields, removed_bytes = normalize_post_quote_padding(original)
            if not affected_fields:
                continue
            validate_normalization(original, normalized, entry.filename)
            replacements[entry.filename] = normalized
            files.append(
                {
                    "member": entry.filename,
                    "affectedFields": affected_fields,
                    "removedPaddingBytes": removed_bytes,
                }
            )

        if not replacements:
            report["files"] = []
            return source, report

        output_directory.mkdir(parents=True, exist_ok=True)
        destination = output_directory / f"{source.stem}.otp-compatible.zip"
        temporary = output_directory / f".{destination.name}.{os.getpid()}.tmp"
        try:
            with zipfile.ZipFile(temporary, "w") as target:
                for entry in archive.infolist():
                    target.writestr(entry, replacements.get(entry.filename, archive.read(entry.filename)))
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)

    report.update(
        {
            "modified": True,
            "compatiblePath": str(destination),
            "compatibleSha256": sha256(destination),
            "files": files,
            "affectedFields": sum(item["affectedFields"] for item in files),
            "removedPaddingBytes": sum(item["removedPaddingBytes"] for item in files),
        }
    )
    return destination, report


def prepare_gtfs_paths_for_otp(sources: list[Path], output_directory: Path) -> tuple[list[Path], list[dict]]:
    prepared = [prepare_gtfs_for_otp(source, output_directory) for source in sources]
    return [path for path, _ in prepared], [report for _, report in prepared]
