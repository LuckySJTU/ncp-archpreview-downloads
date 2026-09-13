import copy
import csv
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from collect import collect, count, get_json, model_items, model_csv, publish


class CollectorTests(unittest.TestCase):
    def mock_fetch(self, url):
        if "/collections/" in url:
            return {"slug": "org/collection", "title": "Test", "items": [
                {"id": "org/Stage1", "type": "model"},
                {"id": "org/Stage1", "type": "model"},
                {"id": "org/Stage2_v1", "type": "model"},
                {"id": "org/data", "type": "dataset"},
            ]}
        model_id = url.split("/models/")[1].split("?")[0]
        return {"id": model_id, "downloads": 5, "downloadsAllTime": 12, "likes": 0}

    def test_collection_deduplication_and_independent_windows(self):
        snapshot = collect("org/collection", self.mock_fetch)
        self.assertEqual(len(snapshot["models"]), 2)
        self.assertEqual(snapshot["totals"], {"downloads30d": 10, "downloadsAllTime": 24, "likes": 0})
        self.assertEqual(snapshot["authentication"], "anonymous")

    def test_missing_is_not_zero(self):
        self.assertEqual(count(0, "downloads", "org/a"), 0)
        for value in (None, False, -1, "42", 1.3, 2**53):
            with self.subTest(value=value), self.assertRaises(ValueError):
                count(value, "downloads", "org/a")

    def test_any_missing_model_prevents_snapshot_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            initial = collect("org/collection", self.mock_fetch)
            publish(initial, output)
            before = {p.relative_to(output): p.read_bytes() for p in output.rglob("*.json")}

            def broken(url):
                data = self.mock_fetch(url)
                if "/models/org/Stage2" in url:
                    data.pop("downloadsAllTime")
                return data

            with self.assertRaises(ValueError):
                publish(collect("org/collection", broken), output)
            after = {p.relative_to(output): p.read_bytes() for p in output.rglob("*.json")}
            self.assertEqual(before, after)

    def test_daily_upsert_retains_baseline_and_prior_days(self):
        first = collect("org/collection", self.mock_fetch)
        first["generatedAt"] = "2026-09-13T01:00:00Z"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            publish(first, output)
            baseline = (output / "baseline.json").read_bytes()
            second = copy.deepcopy(first)
            second["generatedAt"] = "2026-09-13T07:00:00Z"
            publish(second, output)
            history = json.loads((output / "history.json").read_text())
            self.assertEqual(len(history["points"]), 1)
            self.assertEqual(history["points"][0]["generatedAt"], second["generatedAt"])
            second["generatedAt"] = "2026-09-14T01:00:00Z"
            publish(second, output)
            self.assertEqual(len(json.loads((output / "history.json").read_text())["points"]), 2)
            self.assertEqual((output / "baseline.json").read_bytes(), baseline)
            self.assertTrue((output / "history/2026-09-13.json").exists())

    def test_membership_fingerprint_changes(self):
        initial = collect("org/collection", self.mock_fetch)

        def changed(url):
            data = self.mock_fetch(url)
            if "/collections/" in url:
                data["items"] = data["items"][:1]
            return data

        later = collect("org/collection", changed)
        self.assertNotEqual(initial["collection"]["membershipHash"], later["collection"]["membershipHash"])

    def test_empty_or_malformed_collection_is_rejected(self):
        for data in ({}, {"items": []}, {"items": [{"type": "model", "id": "../../bad"}]}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                model_items(data)

    def test_requests_are_anonymous_and_rate_limits_retry(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = io.BytesIO(b'{"ok": true}')
        limited = urllib.error.HTTPError("https://huggingface.co/api/models/a/b", 429, "limited", {"Retry-After": "1"}, None)
        with patch("collect.urllib.request.urlopen", side_effect=[limited, response]) as request, patch("collect.time.sleep") as sleep:
            self.assertEqual(get_json("https://huggingface.co/api/models/a/b"), {"ok": True})
            sleep.assert_called_once_with(1)
            for call in request.call_args_list:
                headers = dict(call.args[0].header_items())
                self.assertFalse(any(k.lower() in ("authorization", "cookie") for k in headers))

    def test_csv_exports_metrics_and_neutralizes_formulas(self):
        result = model_csv([{"id": '=HYPERLINK("x")', "group": 'comma,quote"', "downloads30d": 3, "downloadsAllTime": 10}])
        self.assertTrue(result.startswith("\ufeff"))
        rows = list(csv.DictReader(io.StringIO(result.lstrip("\ufeff"))))
        self.assertEqual(rows[0]["id"], '\'=HYPERLINK("x")')
        self.assertEqual(rows[0]["group"], 'comma,quote"')
        self.assertEqual(rows[0]["downloadsAllTime"], "10")
        self.assertEqual(rows[0]["downloads30d"], "3")


if __name__ == "__main__":
    unittest.main()
