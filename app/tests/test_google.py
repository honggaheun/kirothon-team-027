import importlib
import time
import json
from types import SimpleNamespace
from urllib.parse import urlparse,parse_qs
import pytest
import httpx
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from google.auth import jwt,crypt
from chaenggim.store import Store

def module(name):
    try:return importlib.import_module('chaenggim.'+name)
    except ModuleNotFoundError:return None

private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
pem=private.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
public=private.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode()
def token(**changes):
    return jwt.encode(crypt.RSASigner.from_string(pem,key_id='key'),{'iss':'https://accounts.google.com','aud':'client','sub':'u','email':'u@example.com','email_verified':True,'name':'사용자','iat':int(time.time()),'exp':int(time.time())+3600,'nonce':'nonce',**changes}).decode()
def config():return SimpleNamespace(origin='http://127.0.0.1:4871',client_id='client',client_secret='secret',encryption_key=b'5'*32)

def test_signed_token_nonce_audience_expiry():
    auth=module('auth');assert auth
    assert auth.verify_token(token(),'client','nonce',{'key':public})['sub']=='u'
    for invalid in [token(nonce='wrong'),token(aud='other'),token(exp=1),token()[:-8]+'abcdefgh']:
        with pytest.raises(auth.AppError):auth.verify_token(invalid,'client','nonce',{'key':public})

async def test_oauth_state_replay_encryption_scopes_and_logout():
    auth=module('auth');assert auth
    nonce='';store=Store(':memory:')
    async def handler(req):
        if req.url.path.endswith('certs'):return httpx.Response(200,json={'key':public})
        return httpx.Response(200,json={'id_token':token(nonce=nonce),'access_token':'access-secret','refresh_token':'refresh-secret','expires_in':3600,'scope':'openid email profile'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        oauth=auth.OAuth(store,config(),client);flow=oauth.begin('login');query=parse_qs(urlparse(flow['url']).query);nonce=query['nonce'][0]
        assert query['scope']==['openid email profile'];assert query['code_challenge_method']==['S256']
        with pytest.raises(auth.AppError):await oauth.finish(query['state'][0],'code','wrong',None)
        session=await oauth.finish(query['state'][0],'code',flow['flowId'],None)
        assert oauth.session(session['sid'])['user']['id']=='u'
        assert 'refresh-secret' not in json.dumps(store.all('google'))
        with pytest.raises(auth.AppError):await oauth.finish(query['state'][0],'code',flow['flowId'],None)
        assert 'calendar.app.created' in oauth.begin('calendar','u')['url']
        assert 'gmail.readonly' in oauth.begin('gmail','u')['url']
        oauth.logout(session['sid']);assert oauth.session(session['sid']) is None
    store.close()

async def test_service_connection_cannot_switch_google_account():
    auth=module('auth');assert auth
    nonce='';store=Store(':memory:')
    async def handler(req):
        if req.url.path.endswith('certs'):return httpx.Response(200,json={'key':public})
        return httpx.Response(200,json={'id_token':token(nonce=nonce,sub='intruder'),'access_token':'x','expires_in':3600,'scope':'openid email profile https://www.googleapis.com/auth/calendar.app.created'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        oauth=auth.OAuth(store,config(),client)
        oauth.create_session({'id':'u','ownerId':'u','name':'사용자'})
        flow=oauth.begin('calendar','u');query=parse_qs(urlparse(flow['url']).query);nonce=query['nonce'][0]
        with pytest.raises(auth.AppError,match='같은 Google'):await oauth.finish(query['state'][0],'code',flow['flowId'],'u')
    store.close()

@pytest.mark.parametrize('delete_during', ['token', 'certs'])
@pytest.mark.parametrize('reregister', [False, True])
async def test_connection_callback_cannot_restore_deleted_account(delete_during, reregister):
    from chaenggim.accounts import Accounts
    auth=module('auth');store=Store(':memory:');nonce=''

    async def handler(request):
        assert not store.db.in_transaction, 'OAuth network calls must not hold a transaction'
        if request.url.path.endswith(delete_during):
            await Accounts(store,oauth,client).delete('u')
            if reregister:
                store.put('users',{'id':'u','ownerId':'u','name':'new account','generation':'new-generation'})
        if request.url.path.endswith('certs'):
            return httpx.Response(200,json={'key':public})
        return httpx.Response(200,json={'id_token':token(nonce=nonce),'access_token':'new-access',
                                       'expires_in':3600,'scope':'openid email profile '+auth.SCOPES['calendar']})

    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            oauth=auth.OAuth(store,config(),client)
            old_session=oauth.create_session({'id':'u','ownerId':'u','name':'original'})
            flow=oauth.begin('calendar','u');query=parse_qs(urlparse(flow['url']).query);nonce=query['nonce'][0]
            with pytest.raises(auth.AppError) as error:
                await oauth.finish(query['state'][0],'code',flow['flowId'],'u')
            assert error.value.status==401
            assert store.get('google','u','u') is None
            assert store.all('sessions')==[]
            assert oauth.session(old_session['sid']) is None
            profile=store.get('users','u','u')
            assert profile==({'id':'u','ownerId':'u','name':'new account','generation':'new-generation'} if reregister else None)
    finally:
        store.close()

async def test_explicit_login_can_register_again_after_deletion_during_callback():
    from chaenggim.accounts import Accounts
    auth=module('auth');store=Store(':memory:');nonce=''

    async def handler(request):
        assert not store.db.in_transaction
        if request.url.path.endswith('certs'):
            await Accounts(store,oauth,client).delete('u')
            return httpx.Response(200,json={'key':public})
        return httpx.Response(200,json={'id_token':token(nonce=nonce),'access_token':'new-access',
                                       'expires_in':3600,'scope':'openid email profile'})

    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            oauth=auth.OAuth(store,config(),client)
            old_session=oauth.create_session({'id':'u','ownerId':'u','name':'original'})
            flow=oauth.begin('login');query=parse_qs(urlparse(flow['url']).query);nonce=query['nonce'][0]
            signed=await oauth.finish(query['state'][0],'code',flow['flowId'],None)
            assert signed['user']['generation']!=old_session['user']['generation']
            assert oauth.session(signed['sid']) is not None
            assert oauth.session(old_session['sid']) is None
    finally:
        store.close()

@pytest.mark.parametrize('session_failure', [False, True])
async def test_connection_callback_commits_profile_tokens_and_session_together(monkeypatch, session_failure):
    auth=module('auth');store=Store(':memory:');nonce=''

    async def handler(request):
        assert not store.db.in_transaction
        if request.url.path.endswith('certs'):return httpx.Response(200,json={'key':public})
        return httpx.Response(200,json={'id_token':token(nonce=nonce),'access_token':'new-access',
                                       'expires_in':3600,'scope':'openid email profile '+auth.SCOPES['calendar']})

    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            oauth=auth.OAuth(store,config(),client)
            original=oauth.create_session({'id':'u','ownerId':'u','name':'original'})
            store.put('google',{'id':'u','ownerId':'u','scopes':[],
                                'tokens':oauth.seal({'access_token':'old-access','refresh_token':'old-refresh'},'u')})
            before={collection:store.all(collection) for collection in ('users','google','sessions')}
            flow=oauth.begin('calendar','u');query=parse_qs(urlparse(flow['url']).query);nonce=query['nonce'][0]
            if session_failure:
                put=store.put
                def fail_session(collection, document):
                    if collection=='sessions':raise RuntimeError('session write failed')
                    return put(collection,document)
                monkeypatch.setattr(store,'put',fail_session)
                with pytest.raises(RuntimeError,match='session write failed'):
                    await oauth.finish(query['state'][0],'code',flow['flowId'],'u')
                assert {collection:store.all(collection) for collection in before}==before
            else:
                signed=await oauth.finish(query['state'][0],'code',flow['flowId'],'u')
                assert signed['user']['generation']==original['user']['generation']
                assert oauth.session(signed['sid']) is not None
                assert oauth.connected('u')['calendar'] is True
                saved=oauth.open(store.get('google','u','u')['tokens'],'u')
                assert saved['access_token']=='new-access'
                assert saved['refresh_token']=='old-refresh'
    finally:
        store.close()

@pytest.mark.parametrize('purpose,previous_connection', [('gmail',True),('login',True),('login',False)])
async def test_combined_google_grants_do_not_reenable_local_services(purpose, previous_connection):
    auth=module('auth');store=Store(':memory:');nonce=''
    all_grants=' '.join(auth.SCOPES.values())

    async def handler(request):
        if request.url.path.endswith('certs'):return httpx.Response(200,json={'key':public})
        return httpx.Response(200,json={'id_token':token(nonce=nonce),'access_token':'combined-access',
                                       'expires_in':3600,'scope':all_grants})

    async def finish(purpose):
        nonlocal nonce
        user=None if purpose=='login' else 'u'
        flow=oauth.begin(purpose,user);query=parse_qs(urlparse(flow['url']).query);nonce=query['nonce'][0]
        return await oauth.finish(query['state'][0],'code',flow['flowId'],user)

    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            oauth=auth.OAuth(store,config(),client)
            if previous_connection:
                oauth.create_session({'id':'u','ownerId':'u','name':'original'})
                store.put('google',{'id':'u','ownerId':'u',
                                    'scopes':[auth.SCOPES['calendar'],auth.SCOPES['tasks']],
                                    'tokens':oauth.seal({'access_token':'old-access','scope':all_grants},'u')})
                oauth.disconnect('u','calendar')
            await finish(purpose)
            assert oauth.connected('u')=={'calendar':False,'gmail':purpose=='gmail',
                                         'tasks':previous_connection,'drive':False,'calendar_read':False}
            saved=oauth.open(store.get('google','u','u')['tokens'],'u')
            assert saved['scope']==all_grants
            for service in ('calendar','drive'):
                with pytest.raises(auth.AppError) as error:
                    await oauth.access_token('u',service)
                assert error.value.status==409
            if purpose=='gmail':assert await oauth.access_token('u','gmail')=='combined-access'
            if previous_connection:assert await oauth.access_token('u','tasks')=='combined-access'

            # Only an explicit reconnection restores the user's disabled service.
            await finish('calendar')
            assert oauth.connected('u')=={'calendar':True,'gmail':purpose=='gmail',
                                         'tasks':previous_connection,'drive':False,'calendar_read':False}
            assert await oauth.access_token('u','calendar')=='combined-access'
    finally:
        store.close()

async def test_calendar_read_consent_is_independent_from_calendar_write():
    auth=module('auth');store=Store(':memory:');nonce=''
    read_scope='https://www.googleapis.com/auth/calendar.readonly'
    combined='openid email profile '+read_scope+' '+auth.SCOPES['calendar']

    async def handler(request):
        if request.url.path.endswith('certs'):return httpx.Response(200,json={'key':public})
        return httpx.Response(200,json={'id_token':token(nonce=nonce),'access_token':'calendar-access',
                                       'expires_in':3600,'scope':combined})

    async def finish(purpose):
        nonlocal nonce
        user=None if purpose=='login' else 'u'
        flow=oauth.begin(purpose,user);query=parse_qs(urlparse(flow['url']).query);nonce=query['nonce'][0]
        requested=query['scope'][0].split()
        if purpose=='calendar_read':
            assert read_scope in requested
            assert auth.SCOPES['calendar'] not in requested
        await oauth.finish(query['state'][0],'code',flow['flowId'],user)

    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            oauth=auth.OAuth(store,config(),client)
            oauth.create_session({'id':'u','ownerId':'u','name':'original'})
            await finish('calendar_read')
            assert oauth.connected('u')['calendar_read'] is True
            assert oauth.connected('u')['calendar'] is False
            assert await oauth.access_token('u','calendar_read')=='calendar-access'
            with pytest.raises(auth.AppError) as error:
                await oauth.access_token('u','calendar')
            assert error.value.status==409

            await finish('calendar')
            oauth.disconnect('u','calendar_read')
            assert oauth.connected('u')['calendar_read'] is False
            assert oauth.connected('u')['calendar'] is True
            assert await oauth.access_token('u','calendar')=='calendar-access'
            await finish('login')
            assert oauth.connected('u')['calendar_read'] is False
            assert oauth.connected('u')['calendar'] is True
            with pytest.raises(auth.AppError) as error:
                await oauth.access_token('u','calendar_read')
            assert error.value.status==409
    finally:
        store.close()

async def test_calendar_retry_and_external_conflict():
    calendar=module('calendar');assert calendar
    store=Store(':memory:');store.put('items',{'id':'one','ownerId':'u','kind':'event','approved':True,'title':'소풍','start':'2026-11-21T09:00:00+09:00','end':'2026-11-21T10:00:00+09:00','version':1,'calendar':None})
    posts=0;conflict=False
    async def handler(req):
        nonlocal posts
        if req.method=='POST':posts+=1
        if req.url.path.endswith('/calendars'):return httpx.Response(200,json={'id':'cal'})
        if req.method=='PATCH':return httpx.Response(412 if conflict else 200,json={'id':'remote','etag':'"v2"'})
        if req.method=='GET':return httpx.Response(200,json={'id':'remote','etag':'"external"','summary':'Google에서 변경한 일정','description':'','start':{'dateTime':'2026-11-21T09:00:00+09:00'},'end':{'dateTime':'2026-11-21T10:00:00+09:00'},'reminders':{'useDefault':False}})
        return httpx.Response(200,json={'id':json.loads(req.content)['id'],'etag':'"v1"'})
    class Tokens:
        async def access_token(self,*args):return 'token'
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service=calendar.Calendar(store,Tokens(),client)
        first=await service.sync('u','one');assert first['calendar']['status']=='synced'
        await service.sync('u','one');assert posts==2
        store.put('items',{**first,'version':2});conflict=True
        with pytest.raises(calendar.AppError,match='Google Calendar에서'):await service.sync('u','one')
        assert store.get('items','one','u')['calendar']['syncedVersion']==1
        with pytest.raises(calendar.AppError):await service.sync('other','one')
    store.close()
