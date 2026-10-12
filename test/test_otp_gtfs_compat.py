import csv
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from otp_gtfs_compat import prepare_gtfs_for_otp  # noqa: E402


class OtpGtfsCompatibilityTest(unittest.TestCase):
    def make_feed(self, directory: Path, agency: bytes) -> Path:
        feed = directory / "feed.zip"
        with zipfile.ZipFile(feed, "w") as archive:
            archive.writestr("agency.txt", agency)
            archive.writestr("stops.txt", b"stop_id,stop_name\ns,Stop\n")
        return feed

    def test_removes_only_exterior_padding_after_quoted_field(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            feed = self.make_feed(
                root,
                b'agency_id,agency_name,agency_url\n"1","Name ","https://example.com/" \n',
            )
            original = feed.read_bytes()
            compatible, report = prepare_gtfs_for_otp(feed, root / "out")

            self.assertEqual(feed.read_bytes(), original)
            self.assertNotEqual(compatible, feed)
            self.assertEqual(report["affectedFields"], 1)
            self.assertEqual(report["removedPaddingBytes"], 1)
            self.assertEqual(report["files"], [{"member": "agency.txt", "affectedFields": 1, "removedPaddingBytes": 1}])
            with zipfile.ZipFile(compatible) as archive:
                rows = list(
                    csv.reader(
                        io.TextIOWrapper(archive.open("agency.txt"), encoding="utf-8", newline=""),
                        strict=True,
                    )
                )
                self.assertEqual(archive.read("stops.txt"), b"stop_id,stop_name\ns,Stop\n")
            self.assertEqual(rows[1], ["1", "Name ", "https://example.com/"])

    def test_returns_unmodified_feed_when_csv_is_already_strict(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            feed = self.make_feed(
                root,
                b'agency_id,agency_name,agency_url\n"1","Name","https://example.com/"\n',
            )
            compatible, report = prepare_gtfs_for_otp(feed, root / "out")

            self.assertEqual(compatible, feed.resolve())
            self.assertFalse(report["modified"])
            self.assertEqual(report["files"], [])


if __name__ == "__main__":
    unittest.main()
