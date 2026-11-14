import importlib
from chaenggim.domain import Plans

def test_firestore_transaction_approval_roundtrip_when_enabled():
    """Real cloud smoke lives in scripts/cloud-store-smoke.py; unit boundary guards owner checks."""
    try:cloud=importlib.import_module('chaenggim.cloud_store')
    except ModuleNotFoundError:cloud=None
    assert cloud is not None
    class Session:
        def request(self,method,url,**kwargs):
            class R:
                status_code=200
                def json(self):return {'fields':{'ownerId':{'stringValue':'other'},'payload':{'stringValue':'{"id":"one","ownerId":"other","text":"private"}'}}}
            return R()
    store=cloud.FirestoreStore('project',session=Session())
    assert store.get('sources','one','u') is None
    assert store.get('sources','one','other')['text']=='private'
