"""Firestore REST 트랜잭션 + 비공개 Cloud Storage 첨부. 소유권은 모든 조회에서 확인한다."""
import base64
import copy
import hashlib
import json
from contextlib import contextmanager
from threading import RLock
from urllib.parse import quote
import google.auth
from google.auth.transport.requests import AuthorizedSession
from google.cloud import storage
from .domain import AppError

class FirestoreStore:
    def __init__(self,project,session=None,bucket=None,storage_client=None):
        self.project=project;self.bucket=bucket;self.storage_client=storage_client
        self.session=session or AuthorizedSession(google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])[0])
        self.base=f'https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents'
        self.lock=RLock();self.tx=None;self.pending={}
    def path(self,collection,id):
        if not isinstance(id,str) or not id or '/' in id:raise AppError('자료 식별자를 확인해 주세요.')
        return f'projects/{self.project}/databases/(default)/documents/chaenggim_{collection}/{id}'
    def request(self,method,url,**kwargs):
        response=self.session.request(method,url,timeout=20,**kwargs)
        if response.status_code==404:return None
        if response.status_code in (409,412):raise AppError('다른 작업이 먼저 반영됐어요. 새로고침 후 다시 시도해 주세요.',409)
        if response.status_code not in (200,201):raise AppError(f'데이터 저장소 연결을 확인해 주세요. ({response.status_code})',503)
        return response.json()
    @staticmethod
    def decode(doc):return json.loads(doc['fields']['payload']['stringValue'])
    def get(self,collection,id,owner):
        with self.lock:
            key=(collection,id)
            if key in self.pending:doc=copy.deepcopy(self.pending[key])
            else:
                path=self.path(collection,id)
                raw=self.request('GET','https://firestore.googleapis.com/v1/'+quote(path,safe='/'),params={'transaction':self.tx} if self.tx else None)
                doc=self.decode(raw) if raw else None
            return doc if doc and doc.get('ownerId')==owner else None
    def query(self,collection,owner=None):
        query={'from':[{'collectionId':'chaenggim_'+collection}]}
        if owner is not None:query['where']={'fieldFilter':{'field':{'fieldPath':'ownerId'},'op':'EQUAL','value':{'stringValue':owner}}}
        payload={'structuredQuery':query}
        if self.tx:payload['transaction']=self.tx
        rows=self.request('POST',self.base+':runQuery',json=payload) or []
        found={row['document']['name'].rsplit('/',1)[-1]:self.decode(row['document']) for row in rows if 'document' in row}
        for (category,id),doc in self.pending.items():
            if category==collection:
                if doc is None:found.pop(id,None)
                elif owner is None or doc.get('ownerId')==owner:found[id]=copy.deepcopy(doc)
        return sorted(found.values(),key=lambda d:d.get('createdAt',''),reverse=True)
    def list(self,collection,owner):
        with self.lock:return self.query(collection,owner)
    def all(self,collection):
        with self.lock:return self.query(collection)
    def prepare(self,collection,doc):
        value=copy.deepcopy(doc)
        if value.get('data'):
            if not self.bucket:raise AppError('첨부 저장소 설정이 필요해요.',503)
            binary=base64.b64decode(value.pop('data'))
            object_name=f"private/{hashlib.sha256(value['ownerId'].encode()).hexdigest()}/{value['id']}/{hashlib.sha256(binary).hexdigest()}"
            client=self.storage_client or storage.Client(project=self.project)
            client.bucket(self.bucket).blob(object_name).upload_from_string(binary,content_type=value.get('mime','application/octet-stream'))
            value['_blob']=object_name
        payload=json.dumps(value,ensure_ascii=False)
        if len(payload.encode())>950000:raise AppError('한 자료의 내용이 너무 커요. 나누어 넣어 주세요.')
        return {'name':self.path(collection,doc['id']),'fields':{'ownerId':{'stringValue':doc['ownerId']},'payload':{'stringValue':payload}}}
    def put(self,collection,doc):
        with self.lock:
            if self.tx:self.pending[(collection,doc['id'])]=copy.deepcopy(doc)
            else:
                prepared=self.prepare(collection,doc)
                self.request('PATCH','https://firestore.googleapis.com/v1/'+quote(prepared['name'],safe='/'),json=prepared)
            return doc
    def delete(self,collection,id,owner):
        with self.lock:
            if not self.get(collection,id,owner):return
            if self.tx:self.pending[(collection,id)]=None
            else:self.request('DELETE','https://firestore.googleapis.com/v1/'+quote(self.path(collection,id),safe='/'))
    @contextmanager
    def transaction(self):
        with self.lock:
            if self.tx:raise RuntimeError('Nested Firestore transaction')
            self.tx=self.request('POST',self.base+':beginTransaction',json={'options':{'readWrite':{}}})['transaction']
            self.pending={}
            try:
                yield
                writes=[{'delete':self.path(c,id)} if doc is None else {'update':self.prepare(c,doc)} for (c,id),doc in self.pending.items()]
                self.request('POST',self.base+':commit',json={'transaction':self.tx,'writes':writes})
            except BaseException:
                try:self.request('POST',self.base+':rollback',json={'transaction':self.tx})
                except Exception:pass
                raise
            finally:self.tx=None;self.pending={}
    def read_file(self,doc):
        if doc.get('data'):return base64.b64decode(doc['data'])
        if not doc.get('_blob') or not self.bucket:raise AppError('첨부 파일을 찾을 수 없어요.',404)
        return (self.storage_client or storage.Client(project=self.project)).bucket(self.bucket).blob(doc['_blob']).download_as_bytes()
    def delete_user_files(self,user):
        if not self.bucket:return
        client=self.storage_client or storage.Client(project=self.project)
        prefix='private/'+hashlib.sha256(user.encode()).hexdigest()+'/'
        for blob in client.list_blobs(self.bucket,prefix=prefix):blob.delete()
    def close(self):self.session.close()
