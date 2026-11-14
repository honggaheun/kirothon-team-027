import asyncio
import base64
import json
from types import SimpleNamespace
import httpx
import pytest
from chaenggim.store import Store
from chaenggim.domain import Plans,AppError,validate_proposal
from chaenggim.calendar import Calendar
from chaenggim.gmail import Gmail
from chaenggim.api import create_app

def proposal(title='소풍'):
    return {'title':title,'summary':'준비 계획','questions':[],'items':[{'title':title,'kind':'task','origin':'source','evidence':'소풍'}]}

def test_review_can_select_subset_and_explicitly_match_renamed_revision():
    store=Store(':memory:');plans=Plans(store);source=plans.add_source('u',{'kind':'text','text':'소풍'})
    first=plans.propose('u',source['id'],{**proposal(),'items':[{'title':'지난 행사','kind':'event','start':None},proposal()['items'][0]]})
    selected=plans.edit('u',first['id'],1,[first['items'][1]])
    saved=plans.approve('u',first['id'],selected['version'])['items'][0]
    draft=plans.propose('u',source['id'],proposal('소풍 참가 준비'))
    edited=plans.edit('u',draft['id'],1,[{**draft['items'][0],'replacesId':saved['id']}])
    plans.approve('u',draft['id'],edited['version'])
    assert len(store.list('items','u'))==1
    assert store.get('items',saved['id'],'u')['title']=='소풍 참가 준비'
    store.close()

def test_two_revised_items_cannot_replace_one_existing_item():
    store=Store(':memory:');plans=Plans(store);source=plans.add_source('u',{'kind':'text','text':'소풍'})
    draft=plans.propose('u',source['id'],proposal());item=plans.approve('u',draft['id'],1)['items'][0]
    changed=plans.propose('u',source['id'],{**proposal(),'items':[{**proposal('a')['items'][0],'replacesId':item['id']},{**proposal('b')['items'][0],'replacesId':item['id']}]})
    with pytest.raises(AppError):plans.approve('u',changed['id'],1)
    assert store.get('items',item['id'],'u')['title']=='소풍';store.close()

def test_task_end_only_is_a_due_time_without_inventing_another_date():
    value=validate_proposal({**proposal(),'items':[{'title':'제출','kind':'task','start':None,'end':'2026-11-14T18:00:00+09:00'}]}, {})
    assert value['items'][0]['start']=='2026-11-14T18:00:00+09:00'
    assert value['items'][0]['end'] is None

class Tokens:
    async def access_token(self,*args):return 'token'

async def test_calendar_update_recovers_when_remote_success_response_is_lost():
    store=Store(':memory:');store.put('calendar',{'id':'u','ownerId':'u','calendarId':'cal'})
    store.put('items',{'id':'one','ownerId':'u','kind':'event','approved':True,'title':'소풍','start':'2026-11-21T10:00:00+09:00','end':'2026-11-21T11:00:00+09:00','version':2,'calendar':{'etag':'"v1"','syncedVersion':1}})
    remote=None
    async def handler(req):
        nonlocal remote
        if req.method=='PATCH':
            if remote:return httpx.Response(412,json={})
            remote={**json.loads(req.content),'id':'remote','etag':'"v2"'}
            raise httpx.ReadTimeout('response lost',request=req)
        if req.method=='GET':return httpx.Response(200,json=remote)
        raise AssertionError(req.method)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service=Calendar(store,Tokens(),client)
        with pytest.raises(Exception):await service.sync('u','one')
        saved=await service.sync('u','one')
        assert saved['calendar']['syncedVersion']==2
        assert saved['calendar']['etag']=='"v2"'
    store.close()

async def test_unknown_calendar_creation_does_not_create_another_calendar():
    store=Store(':memory:');store.put('items',{'id':'one','ownerId':'u','kind':'event','approved':True,'title':'소풍','start':'2026-11-21T10:00:00+09:00','end':'2026-11-21T11:00:00+09:00','version':1})
    creates=0
    async def handler(req):
        nonlocal creates
        if req.url.path.endswith('/calendars'):
            creates+=1;raise httpx.ReadTimeout('creation succeeded, response lost',request=req)
        raise AssertionError(req.url)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service=Calendar(store,Tokens(),client)
        with pytest.raises(Exception):await service.sync('u','one')
        with pytest.raises(Exception):await service.sync('u','one')
        assert creates==1
    store.close()

async def test_gmail_paginates_past_seen_messages_and_supplies_source_date():
    store=Store(':memory:');plans=Plans(store);sources=[]
    store.put('gmail-seen',{'id':'u:seen','ownerId':'u'})
    async def handler(req):
        if req.url.path.endswith('/messages'):
            if req.url.params.get('pageToken')=='next':return httpx.Response(200,json={'messages':[{'id':'new'}]})
            return httpx.Response(200,json={'messages':[{'id':'seen'}],'nextPageToken':'next'})
        return httpx.Response(200,json={'id':'new','internalDate':'1794499200000','payload':{'mimeType':'text/plain','headers':[{'name':'Subject','value':'소풍'}],'body':{'data':base64.urlsafe_b64encode('소풍 내일'.encode()).decode()}}})
    async def analyze(source):sources.append(source);return proposal()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service=Gmail(store,plans,Tokens(),analyze,client);service.settings('u',{'enabled':True,'query':'공지'})
        assert (await service.collect('u'))['imported']==1
        assert sources[0]['receivedAt'].startswith('2026-11-12')
    store.close()

async def test_gmail_rechecks_dedupe_marker_inside_persistence_transaction():
    store=Store(':memory:');plans=Plans(store);entered=0;barrier=asyncio.Event()
    async def handler(req):
        if req.url.path.endswith('/messages'):return httpx.Response(200,json={'messages':[{'id':'m'}]})
        return httpx.Response(200,json={'id':'m','snippet':'소풍','payload':{'headers':[]}})
    async def analyze(source):
        nonlocal entered
        entered+=1
        if entered==2:barrier.set()
        await barrier.wait();return proposal()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        a,b=Gmail(store,plans,Tokens(),analyze,client),Gmail(store,plans,Tokens(),analyze,client)
        a.settings('u',{'enabled':True,'query':'공지'})
        result=await asyncio.gather(a.collect('u'),b.collect('u'))
        assert sum(v['imported'] for v in result)==1
        assert len(store.list('drafts','u'))==1
    store.close()

async def test_revision_version_checked_again_after_analysis():
    store=Store(':memory:');plans=Plans(store);source=plans.add_source('u',{'kind':'text','text':'소풍','title':'소풍'})
    entered=0;barrier=asyncio.Event()
    async def analyze(source):
        nonlocal entered
        entered+=1
        if entered==2:barrier.set()
        await barrier.wait();return proposal()
    cfg=SimpleNamespace(origin='http://test',demo=False,client_id='',client_secret='',encryption_key=b'0'*32,project='test',model='test-model')
    a,b=create_app(cfg,store=store,analyze=analyze),create_app(cfg,store=store,analyze=analyze)
    user=store.put('users',{'id':'u','ownerId':'u','name':'테스트'});signed=a.state.oauth.create_session(user)
    headers={'Origin':'http://test','X-CSRF-Token':signed['csrf'],'Cookie':'cg_sid='+signed['sid']}
    async with a.router.lifespan_context(a), b.router.lifespan_context(b):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a),base_url='http://test') as ca,httpx.AsyncClient(transport=httpx.ASGITransport(app=b),base_url='http://test') as cb:
            responses=await asyncio.gather(ca.post('/api/sources/'+source['id']+'/revise',headers=headers,json={'kind':'text','text':'소풍 안내1'}),cb.post('/api/sources/'+source['id']+'/revise',headers=headers,json={'kind':'text','text':'소풍 안내2'}))
            assert sorted(r.status_code for r in responses)==[201,409]
    store.close()
