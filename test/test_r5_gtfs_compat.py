import csv
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from r5_gtfs_compat import prepare_gtfs_for_r5  # noqa: E402


def csv_bytes(fields, rows):
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode()


class R5GtfsCompatibilityTest(unittest.TestCase):
    def make_feed(self, directory, transfers, blocks):
        feed = directory / "feed.zip"
        trip_rows = [{"route_id": "r", "service_id": "s", "trip_id": trip_id, "block_id": block} for trip_id, block in blocks.items()]
        with zipfile.ZipFile(feed, "w") as archive:
            archive.writestr("trips.txt", csv_bytes(["route_id", "service_id", "trip_id", "block_id"], trip_rows))
            archive.writestr(
                "transfers.txt",
                csv_bytes(["from_stop_id", "to_stop_id", "transfer_type", "from_trip_id", "to_trip_id"], transfers),
            )
            archive.writestr("stops.txt", b"stop_id,stop_name\ns,Stop\n")
        return feed

    def test_removes_only_safe_same_block_type_four_rows(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            feed = self.make_feed(
                root,
                [
                    {"from_stop_id": "a", "to_stop_id": "b", "transfer_type": "2", "from_trip_id": "", "to_trip_id": ""},
                    {"from_stop_id": "a", "to_stop_id": "a", "transfer_type": "1", "from_trip_id": "t1", "to_trip_id": "t2"},
                    {"from_stop_id": "b", "to_stop_id": "b", "transfer_type": "4", "from_trip_id": "t1", "to_trip_id": "t2"},
                ],
                {"t1": "block", "t2": "block"},
            )
            original = feed.read_bytes()
            compatible, report = prepare_gtfs_for_r5(feed, root / "out")
            self.assertEqual(feed.read_bytes(), original)
            self.assertNotEqual(compatible, feed)
            self.assertEqual(report["transfers"]["removedRows"], 2)
            self.assertEqual(report["transfers"]["removedByType"], {"1": 1, "4": 1})
            self.assertEqual(report["transfers"]["unsupportedScopedRows"], 1)
            with zipfile.ZipFile(compatible) as archive:
                with archive.open("transfers.txt") as stream:
                    reader = csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8"))
                    rows = list(reader)
                    self.assertEqual(reader.fieldnames, ["from_stop_id", "to_stop_id", "transfer_type", "min_transfer_time"])
                self.assertEqual([row["transfer_type"] for row in rows], ["2"])
                self.assertEqual(archive.read("stops.txt"), b"stop_id,stop_name\ns,Stop\n")

    def test_rejects_type_four_without_matching_block_continuity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            feed = self.make_feed(
                root,
                [{"from_stop_id": "b", "to_stop_id": "b", "transfer_type": "4", "from_trip_id": "t1", "to_trip_id": "t2"}],
                {"t1": "block-a", "t2": "block-b"},
            )
            with self.assertRaisesRegex(ValueError, "matching non-empty block_id"):
                prepare_gtfs_for_r5(feed, root / "out")

    def test_omits_scoped_legacy_rows_without_modern_transfer_types(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            feed = self.make_feed(
                root,
                [
                    {"from_stop_id": "a", "to_stop_id": "a", "transfer_type": "1", "from_trip_id": "t1", "to_trip_id": "t2"},
                    {"from_stop_id": "a", "to_stop_id": "b", "transfer_type": "2", "from_trip_id": "", "to_trip_id": ""},
                ],
                {"t1": "block", "t2": "block"},
            )
            compatible, report = prepare_gtfs_for_r5(feed, root / "out")
            self.assertTrue(report["modified"])
            self.assertEqual(report["transfers"]["unsupportedScopedRows"], 1)
            with zipfile.ZipFile(compatible) as archive:
                with archive.open("transfers.txt") as stream:
                    rows = list(csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8")))
            self.assertEqual([row["transfer_type"] for row in rows], ["2"])


if __name__ == "__main__":
    unittest.main()
