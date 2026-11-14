import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest

from chaenggim import api
from chaenggim.domain import Plans
from chaenggim.store import Store

ORIGIN = 'http://127.0.0.1:4871'


def settings(**changes):
    return SimpleNamespace(**{
        'origin': ORIGIN, 'demo': True, 'client_id': '', 'client_secret': '',
        'encryption_key': b'0' * 32, 'project': 'test-project', 'model': 'test-model',
        **changes,
    })


async def analyze(source):
    return {'title': '물 준비', 'summary': '공지 정리', 'questions': [],
            'items': [{'title': '물 준비', 'kind': 'task', 'origin': 'source', 'evidence': '물 준비'}]}


@pytest.fixture
def app_client(monkeypatch):
    class Router:
        def __init__(self, vertex):
            self.calls = []

        async def route(self, text, context):
            self.calls.append((text, context))
            return {'tool': 'list'}

    routers = []

    def create_router(vertex):
        router = Router(vertex)
        routers.append(router)
        return router

    monkeypatch.setattr(api, 'IntentRouter', create_router)

    @asynccontextmanager
    async def opened():
        requests = []

        async def google(request):
            requests.append(request)
            assert str(request.url) == 'https://oauth2.googleapis.com/revoke'
            return httpx.Response(200, json={})

        store = Store(':memory:')
        try:
            async with httpx.AsyncClient(transport=httpx.MockTransport(google)) as outbound:
                app = api.create_app(settings(), store=store, analyze=analyze, client=outbound)
                async with app.router.lifespan_context(app):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
                        yield SimpleNamespace(app=app, client=client, store=store,
                                              router=routers[-1], requests=requests)
        finally:
            store.close()

    return opened


def signed_user(env, user_id):
    user = env.store.get('users', user_id, user_id)
    if user is None:
        user = env.store.put('users', {'id': user_id, 'ownerId': user_id,
                                      'name': user_id, 'email': user_id + '@example.com'})
    return env.app.state.oauth.create_session(user)


def use_session(env, session):
    env.client.cookies.clear()
    env.client.cookies.set('cg_sid', session['sid'], domain='127.0.0.1', path='/')
    return {'Origin': ORIGIN, 'X-CSRF-Token': session['csrf']}


async def test_http_auth_csrf_approval_and_owner_isolation(app_client):
    async with app_client() as env:
        client = env.client
        assert (await client.get('/api/state')).status_code == 401
        assert (await client.post('/auth/demo')).status_code == 403
        assert (await client.post('/auth/demo', headers={'Origin': ORIGIN})).status_code == 200
        me = (await client.get('/api/me')).json()
        headers = {'Origin': ORIGIN, 'X-CSRF-Token': me['csrf']}
        assert (await client.post('/api/sources', json={'kind': 'text', 'text': '물 준비'})).status_code == 403
        response = await client.post('/api/sources', headers=headers, json={'kind': 'text', 'text': '물 준비'})
        assert response.status_code == 201
        draft = response.json()['draft']
        assert (await client.get('/api/state')).json()['items'] == []
        assert (await client.post('/api/drafts/' + draft['id'] + '/approve', headers=headers,
                                  json={'version': 1})).status_code == 200
        assert len((await client.get('/api/state')).json()['items']) == 1
        own_session = {'sid': client.cookies.get('cg_sid'), 'csrf': me['csrf']}
        use_session(env, signed_user(env, 'other'))
        assert (await client.get('/api/sources/' + draft['sourceId'])).status_code == 404
        use_session(env, own_session)
        assert (await client.post('/auth/logout', headers=headers)).status_code == 200
        assert (await client.get('/api/state')).status_code == 401


async def test_chat_requires_login_and_returns_only_current_users_state(app_client):
    async with app_client() as env:
        assert (await env.client.get('/api/chat')).status_code == 401
        for owner in ('alice', 'bob'):
            signed_user(env, owner)
            env.store.put('chat', {'id': owner, 'ownerId': owner,
                                  'messages': [{'id': owner + '-message', 'role': 'assistant',
                                                'text': owner + ' private history'}]})
            env.store.put('chat-pending', {'id': owner, 'ownerId': owner, 'draftId': owner + '-draft'})
            env.store.put('items', {'id': owner + '-task', 'ownerId': owner, 'kind': 'task',
                                   'title': owner + ' private task', 'approved': True, 'done': False})
        headers = use_session(env, signed_user(env, 'alice'))
        response = await env.client.get('/api/chat', params={'userId': 'bob'})
        assert response.status_code == 200
        assert response.json()['pendingDraftId'] == 'alice-draft'
        assert [message['id'] for message in response.json()['messages']] == ['alice-message']
        assert 'bob' not in response.text
        listed = await env.client.post('/api/chat', headers=headers, json={'text': '내 할 일 보여줘'})
        assert listed.status_code == 200
        assert 'alice private task' in listed.json()['messages'][-1]['text']
        assert 'bob' not in listed.text
        assert [item['id'] for item in env.router.calls[0][1]['items']] == ['alice-task']
        assert len(env.store.get('chat', 'bob', 'bob')['messages']) == 1
        assert env.requests == []


async def test_chat_logout_enforces_csrf_and_invalidates_cookie_and_session(app_client):
    async with app_client() as env:
        session = signed_user(env, 'alice')
        headers = use_session(env, session)
        for invalid in ({'Origin': ORIGIN}, {**headers, 'Origin': 'https://attacker.example'}):
            response = await env.client.post('/api/chat', headers=invalid, json={'text': '로그아웃'})
            assert response.status_code == 403
            assert env.app.state.oauth.session(session['sid']) is not None
        response = await env.client.post('/api/chat', headers=headers, json={'text': '로그아웃'})
        assert response.status_code == 200
        assert response.json()['loggedOut'] is True
        assert 'Max-Age=0' in response.headers['set-cookie']
        assert env.client.cookies.get('cg_sid') is None
        assert (await env.client.get('/api/chat')).status_code == 401
        use_session(env, session)
        assert (await env.client.get('/api/chat')).status_code == 401
        assert env.router.calls == []
        assert env.requests == []


async def test_account_delete_erases_owned_data_and_all_sessions_only(app_client):
    async with app_client() as env:
        alice = signed_user(env, 'alice')
        second_alice = signed_user(env, 'alice')
        bob = signed_user(env, 'bob')
        collections = ('sources', 'drafts', 'items', 'gmail-seen', 'gmail-settings',
                       'calendar', 'tasks', 'chat', 'chat-pending', 'drive', 'tasks-claims')
        for owner in ('alice', 'bob'):
            for collection in collections:
                env.store.put(collection, {'id': owner + '-' + collection, 'ownerId': owner})
            env.store.put('oauth', {'id': owner + '-flow', 'ownerId': '@system', 'userId': owner})
            env.store.put('google', {'id': owner, 'ownerId': owner, 'scopes': [],
                                    'tokens': env.app.state.oauth.seal({'refresh_token': owner + '-refresh'}, owner)})
        headers = use_session(env, alice)
        for invalid in ({'Origin': ORIGIN}, {**headers, 'Origin': 'https://attacker.example'}):
            response = await env.client.post('/api/account/delete', headers=invalid, json={})
            assert response.status_code == 403
            assert env.store.get('users', 'alice', 'alice') is not None
        response = await env.client.post('/api/account/delete', headers=headers, json={'userId': 'bob'})
        assert response.status_code == 200
        assert response.json() == {'ok': True, 'cleanupPending': False}
        assert 'Max-Age=0' in response.headers['set-cookie']
        assert env.client.cookies.get('cg_sid') is None
        for collection in (*collections, 'users', 'google'):
            assert env.store.list(collection, 'alice') == []
            assert len(env.store.list(collection, 'bob')) == 1
        assert env.store.get('oauth', 'alice-flow', '@system') is None
        assert env.store.get('oauth', 'bob-flow', '@system') is not None
        for revoked in (alice, second_alice):
            use_session(env, revoked)
            assert (await env.client.get('/api/chat')).status_code == 401
            assert (await env.client.get('/api/state')).status_code == 401
        use_session(env, bob)
        assert (await env.client.get('/api/me')).json()['user']['id'] == 'bob'
        assert len(env.requests) == 1
        assert env.requests[0].method == 'POST'
        assert env.requests[0].content == b'token=alice-refresh'
        assert env.router.calls == []


def test_demo_public_origin_disallowed():
    store = Store(':memory:')
    try:
        with pytest.raises(ValueError, match='로컬'):
            api.create_app(settings(origin='https://example.com'), store=store)
    finally:
        store.close()


async def streamed_request_across_reregistration(env, path, payload, method='POST', prepare=None):
    previous = signed_user(env, 'alice')
    headers = use_session(env, previous)
    waiting, resume = asyncio.Event(), asyncio.Event()
    encoded = json.dumps(payload, ensure_ascii=False).encode()

    async def body():
        yield encoded[:1]
        waiting.set()
        await resume.wait()
        yield encoded[1:]

    pending = asyncio.create_task(env.client.request(method, path, headers=headers, content=body()))
    try:
        await asyncio.wait_for(waiting.wait(), 3)
        deleted = await env.client.post('/api/account/delete', headers=headers)
        assert deleted.status_code == 200
        replacement = signed_user(env, 'alice')
        assert replacement['user']['generation'] != previous['user']['generation']
        use_session(env, replacement)
        new_source = Plans(env.store).add_source('alice', {'kind': 'text', 'title': '새 계정 자료', 'text': '물 준비'})
        if prepare:
            prepare(new_source)
    finally:
        resume.set()
    response = await asyncio.wait_for(pending, 3)
    return response, replacement, new_source


async def test_streamed_old_chat_delete_cannot_delete_reregistered_account(app_client):
    async with app_client() as env:
        response, replacement, source = await streamed_request_across_reregistration(
            env, '/api/chat', {'text': '회원 탈퇴'})
        assert response.status_code == 401
        assert env.store.get('users', 'alice', 'alice')['generation'] == replacement['user']['generation']
        assert env.store.get('sources', source['id'], 'alice') == source
        assert env.app.state.oauth.session(replacement['sid']) is not None
        assert (await env.client.get('/api/me')).json()['user']['generation'] == replacement['user']['generation']
        assert env.store.list('chat', 'alice') == []
        assert env.requests == []


@pytest.mark.parametrize('operation', ['approve', 'edit'])
async def test_streamed_old_draft_request_cannot_mutate_reregistered_data(app_client, operation):
    async with app_client() as env:
        signed_user(env, 'alice')
        plans = Plans(env.store)
        source = plans.add_source('alice', {'kind': 'text', 'text': '물 준비'})
        old_draft = plans.propose('alice', source['id'], await analyze(source))
        payload = {'version': 1}
        path = '/api/drafts/' + old_draft['id']
        method = 'PATCH'
        if operation == 'approve':
            path += '/approve'
            method = 'POST'
        else:
            payload['items'] = [{**old_draft['items'][0], 'title': '오래된 요청의 수정'}]
        replacement_drafts = []

        def prepare(new_source):
            replacement_draft = {**old_draft, 'sourceId': new_source['id'], 'title': '새 계정 계획'}
            env.store.put('drafts', replacement_draft)
            replacement_drafts.append(replacement_draft)

        response, replacement, new_source = await streamed_request_across_reregistration(
            env, path, payload, method=method, prepare=prepare)
        assert response.status_code == 401
        assert env.store.get('drafts', old_draft['id'], 'alice') == replacement_drafts[0]
        assert env.store.list('items', 'alice') == []
        assert env.store.get('sources', new_source['id'], 'alice') == new_source
        assert env.app.state.oauth.session(replacement['sid']) is not None


async def test_dependency_rejects_changed_generation_before_bodyless_delete(app_client, monkeypatch):
    async with app_client() as env:
        previous = signed_user(env, 'alice')
        headers = use_session(env, previous)
        original_session = env.app.state.oauth.session
        replacement = []

        def session_with_account_rotation(sid):
            captured = original_session(sid)
            if captured and sid == previous['sid'] and not replacement:
                env.store.put('users', {**captured['user'], 'generation': 'new-generation'})
                replacement.append(env.app.state.oauth.create_session(env.store.get('users', 'alice', 'alice')))
            return captured

        monkeypatch.setattr(env.app.state.oauth, 'session', session_with_account_rotation)
        response = await env.client.post('/api/account/delete', headers=headers)
        assert response.status_code == 401
        assert env.store.get('users', 'alice', 'alice')['generation'] == 'new-generation'
        assert original_session(replacement[0]['sid']) is not None
