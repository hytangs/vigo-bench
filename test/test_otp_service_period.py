import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile


spec = importlib.util.spec_from_file_location('otp_gtfs_compat', Path(__file__).parents[1] / 'scripts/otp_gtfs_compat.py')
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)


class ServicePeriodTests(unittest.TestCase):
    def test_historical_query_and_all_feed_calendars_are_retained(self):
        with tempfile.TemporaryDirectory() as temporary:
            first, second = Path(temporary)/'rail.zip', Path(temporary)/'bus.zip'
            with zipfile.ZipFile(first, 'w') as feed:
                feed.writestr('calendar.txt', 'service_id,start_date,end_date\nrail,20250601,20250630\n')
            with zipfile.ZipFile(second, 'w') as feed:
                feed.writestr('nested/calendar_dates.txt', 'service_id,date,exception_type\nbus,20250531,1\nbus,20270101,1\n')
            self.assertEqual(compat.service_period([first,second], '2025-06-29'),
                             {'transitServiceStart':'2025-05-31', 'transitServiceEnd':'2027-01-01'})

    def test_no_calendar_does_not_substitute_the_computer_date(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'feed.zip'
            with zipfile.ZipFile(path, 'w') as feed:
                feed.writestr('stops.txt', 'stop_id\na\n')
            self.assertEqual(compat.service_period([path], '2025-06-29'),
                             {'transitServiceStart':'2025-06-29', 'transitServiceEnd':'2025-06-29'})
