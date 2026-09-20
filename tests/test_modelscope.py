import contextlib
import csv
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse
from urllib.error import HTTPError
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from collect import collect_modelscope, get_json, model_csv, publish, refresh


class ModelScopeTests(unittest.TestCase):
    def setUp(self):
        self.members = ['org/Stage1', 'org/Stage2_v1']

    def fetch(self, url):
        path = urlparse(url).path
        if '/models/' in path:
            owner, name = path.split('/models/')[1].split('/')
            return {'Code': 200, 'Success': True, 'Data': {'Path': owner, 'Name': name, 'Downloads': 14, 'Stars': 1, 'CreatedTime': 1789904748, 'LastUpdatedTime': 1789905945}}
        info = {'Path': 'org/release', 'Fid': 'release-id', 'Private': 0, 'Name': 'Release', 'ElementCount': len(self.members) + 1, 'ElementTypeCount': {'model': len(self.members), 'paper': 1}}
        if not path.endswith('/info'):
            entries = [{'Fid': 'paper', 'ElementType': 'paper'}] + [
                {'Fid': model, 'ElementType': 'model', 'ElementPath': model.split('/')[0], 'ElementName': model.split('/')[1]} for model in self.members]
            # Simulate a server-side page-size cap, requiring real pagination.
            page = int(parse_qs(urlparse(url).query)['PageNumber'][0])
            info['CollectionElements'] = {'Total': len(entries), 'CollectionElementVoList': entries[(page - 1) * 2:page * 2]}
        return {'Code': 200, 'Success': True, 'Data': info}

    def test_discovers_new_models_on_later_runs_and_excludes_papers(self):
        first = collect_modelscope('org/release', self.fetch)
        self.assertEqual(first['totals'], {'platformDownloads': 28, 'likes': 2})
        self.assertNotIn('downloadsAllTime', first['totals'])
        self.assertNotIn('downloads30d', first['models'][0])
        self.members.append('org/Stage2_v2')
        second = collect_modelscope('org/release', self.fetch)
        self.assertEqual(second['collection']['modelCount'], 3)
        self.assertEqual(second['totals']['platformDownloads'], 42)
        self.assertNotEqual(first['collection']['membershipHash'], second['collection']['membershipHash'])
        rows = list(csv.DictReader(io.StringIO(model_csv(second['models'], 'modelscope').lstrip('\ufeff'))))
        self.assertEqual(rows[0]['platformDownloads'], '14')
        self.assertNotIn('downloadsAllTime', rows[0])

    def test_failure_or_missing_statistics_preserve_last_snapshot(self):
        initial = collect_modelscope('org/release', self.fetch)
        for corruption in ('Downloads', 'Name', 'Success'):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                publish(initial, output)
                before = (output / 'latest.json').read_bytes()
                def broken(url):
                    data = self.fetch(url)
                    if '/models/' in url:
                        if corruption == 'Success':
                            data['Success'] = False
                        else:
                            data['Data'].pop(corruption)
                    return data
                with self.assertRaises(ValueError):
                    publish(collect_modelscope('org/release', broken), output)
                self.assertEqual((output / 'latest.json').read_bytes(), before)

    def test_pagination_duplicates_and_changing_totals_are_rejected(self):
        for corruption in ('duplicate', 'total', 'path'):
            with self.subTest(corruption=corruption):
                def broken(url):
                    data = self.fetch(url)
                    if 'PageNumber=2' in url:
                        if corruption == 'duplicate':
                            data['Data']['CollectionElements']['CollectionElementVoList'][0]['Fid'] = 'paper'
                        elif corruption == 'total':
                            data['Data']['CollectionElements']['Total'] += 1
                        else:
                            data['Data']['Path'] = 'org/elsewhere'
                    return data
                with self.assertRaises(ValueError):
                    collect_modelscope('org/release', broken)

    def test_sources_update_independently_and_record_failed_attempt(self):
        config = {'collection': 'org/hf', 'modelscopeCollection': 'org/release'}
        def both(url):
            if 'modelscope.cn/' in url:
                return self.fetch(url)
            if '/collections/' in url:
                return {'slug': 'org/hf', 'items': [{'type': 'model', 'id': 'org/Stage1'}]}
            return {'id': 'org/Stage1', 'downloadsAllTime': 25, 'downloads': 5, 'likes': 1}
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            output = Path(directory)
            self.assertTrue(refresh(config, output, fetch=both))
            previous_ms = (output / 'modelscope/latest.json').read_bytes()
            baseline = (output / 'baseline.json').read_bytes()
            def ms_down(url):
                if 'modelscope.cn/' in url:
                    raise TimeoutError('ModelScope temporarily unavailable')
                data = both(url)
                if '/models/' in url:
                    data['downloadsAllTime'] = 27
                return data
            self.assertFalse(refresh(config, output, fetch=ms_down))
            self.assertEqual(json.loads((output / 'latest.json').read_text())['totals']['downloadsAllTime'], 27)
            self.assertEqual((output / 'modelscope/latest.json').read_bytes(), previous_ms)
            self.assertEqual((output / 'baseline.json').read_bytes(), baseline)
            self.assertFalse(json.loads((output / 'modelscope/status.json').read_text())['ok'])
            self.members.append('org/Stage2_v2')
            self.assertTrue(refresh(config, output, fetch=both))
            self.assertTrue(json.loads((output / 'modelscope/status.json').read_text())['ok'])
            self.assertEqual(json.loads((output / 'modelscope/latest.json').read_text())['collection']['modelCount'], 3)

    def test_modelscope_requests_are_anonymous(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = io.BytesIO(b'{"Code": 200}')
        with patch('collect.urllib.request.urlopen', return_value=response) as request:
            get_json('https://www.modelscope.cn/api/v1/models/org/a')
        headers = dict(request.call_args.args[0].header_items())
        self.assertFalse(any(k.lower() in ('authorization', 'cookie') for k in headers))

    def test_preconfigured_path_becomes_available_without_collection_changes(self):
        candidate = 'org/Stage2_v3'
        def not_live(url):
            if url.endswith('/' + candidate):
                raise HTTPError(url, 404, 'not yet published', {}, None)
            return self.fetch(url)
        first = collect_modelscope('org/release', not_live, candidates=[candidate])
        self.assertEqual(first['collection']['targetCount'], 3)
        self.assertEqual(first['collection']['pendingCount'], 1)
        self.assertEqual(first['totals']['platformDownloads'], 28)
        self.assertEqual(first['pendingModels'][0]['id'], candidate)
        self.assertNotIn('platformDownloads', first['pendingModels'][0])
        second = collect_modelscope('org/release', self.fetch, candidates=[candidate])
        self.assertEqual(second['collection']['pendingCount'], 0)
        self.assertEqual(second['totals']['platformDownloads'], 42)
        self.assertEqual(len(self.members), 2)  # No one added it to the collection.
        self.assertNotEqual(first['collection']['membershipHash'], second['collection']['membershipHash'])
        rows = list(csv.DictReader(io.StringIO(model_csv(first['models'] + first['pendingModels'], 'modelscope').lstrip('\ufeff'))))
        self.assertEqual(rows[-1]['status'], 'pending')
        self.assertEqual(rows[-1]['platformDownloads'], '')
        # Once readable, disappearing statistics must not silently become pending.
        with self.assertRaises(HTTPError):
            collect_modelscope('org/release', not_live, candidates=[candidate], previous_ids=[candidate])

    def test_transient_errors_are_not_misclassified_as_pending(self):
        def unavailable(url):
            if url.endswith('/org/Stage2_v3'):
                raise HTTPError(url, 503, 'service unavailable', {}, None)
            return self.fetch(url)
        with self.assertRaises(HTTPError):
            collect_modelscope('org/release', unavailable, candidates=['org/Stage2_v3'])


if __name__ == '__main__':
    unittest.main()
