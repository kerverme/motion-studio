import hashlib,json,os,sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from lemo_worker.catalog import enabled,required_gates,style_spec


class FilmPermissionTests(unittest.TestCase):
    def test_private_owner_films_do_not_claim_a_commercial_service_licence(self):
        with patch.dict(os.environ,{'LEMO_STYLE_LIBRARY':'owner-films'},clear=True):
            for name in required_gates():os.environ[name]='true'
            self.assertTrue(enabled())
            self.assertNotIn('LEMO_LICENSE_APPROVED',os.environ)
            os.environ['LEMO_PRIVATE_OWNER_MODE']='false'
            self.assertFalse(enabled())
            with self.assertRaisesRegex(RuntimeError,'permission'):style_spec('dataviz')
    def test_owner_permission_cannot_enable_a_commercial_style_service(self):
        with patch.dict(os.environ,{'LEMO_STYLE_LIBRARY':'owner-films'},clear=True):
            for name in required_gates():os.environ[name]='true'
            os.environ['LEMO_STYLE_LIBRARY']='upstream-licensed'
            self.assertFalse(enabled())
            with self.assertRaisesRegex(RuntimeError,'permission'):style_spec('dataviz')
    def test_original_directions_do_not_read_private_documents(self):
        with patch.dict(os.environ,{'LEMO_STYLE_LIBRARY':'cloudbath-original-v1','LEMO_ORIGINAL_STYLE_VERIFIED':'true'},clear=True),patch('lemo_worker.catalog.private_spec',side_effect=AssertionError('private docs read')):
            self.assertIn('verified story data',style_spec('dataviz'))

    def test_private_coordinator_bundle_must_match_the_pinned_hash(self):
        spec='Test-only direction; no upstream documentation.'
        lock={'styles':[{'id':'dataviz','spec_sha256':hashlib.sha256(spec.encode()).hexdigest()}]}
        env={'LEMO_STYLE_LIBRARY':'owner-films','LEMO_FILM_USE_APPROVED':'true','LEMO_PRIVATE_OWNER_MODE':'true','LEMO_PRIVATE_STYLES_JSON':json.dumps({'dataviz':spec})}
        with patch.dict(os.environ,env,clear=True),patch('lemo_worker.catalog.LOCK',lock):
            self.assertEqual(style_spec('dataviz'),spec)
            os.environ['LEMO_PRIVATE_STYLES_JSON']=json.dumps({'dataviz':spec+' changed'})
            with self.assertRaisesRegex(ValueError,'pinned'):style_spec('dataviz')
            os.environ['LEMO_PRIVATE_STYLES_JSON']='{}'
            with self.assertRaisesRegex(ValueError,'missing'):style_spec('dataviz')


if __name__=='__main__':unittest.main()
