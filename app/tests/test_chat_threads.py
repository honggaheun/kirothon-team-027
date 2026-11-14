import asyncio
import pytest

from chaenggim.chat import ChatAgent, IntentRouter
from chaenggim.domain import AppError
from test_chat import agent, Router, store, proposal


async def test_two_threads_keep_history_and_pending_drafts_isolated_after_reload(store):
    service = agent(store)
    first, second = service.create_thread('u'), service.create_thread('u')
    one = await service.for_thread('u', first['id']).send('u', {'text': '첫 번째 대회 공지'})
    two = await service.for_thread('u', second['id']).send('u', {'text': '두 번째 대회 공지'})
    assert one['pendingDraftId'] != two['pendingDraftId']
    assert one['messages'][0]['text'] == '첫 번째 대회 공지'
    assert two['messages'][0]['text'] == '두 번째 대회 공지'
    reloaded = agent(store)
    assert reloaded.for_thread('u', first['id']).state('u') == one
    assert reloaded.for_thread('u', second['id']).state('u') == two
    listed = reloaded.list_threads('u')['threads']
    assert {row['title'] for row in listed} == {'첫 번째 대회 공지', '두 번째 대회 공지'}
    assert all('generation' not in row and 'ownerId' not in row for row in listed)
    await reloaded.for_thread('u', first['id']).send('u', {'text': '계획 승인'})
    assert reloaded.for_thread('u', first['id']).state('u')['pendingDraftId'] is None
    assert reloaded.for_thread('u', second['id']).state('u')['pendingDraftId'] == two['pendingDraftId']


async def test_thread_ownership_read_send_delete_and_list_are_enforced(store):
    service = agent(store)
    thread = service.create_thread('u', '개인 대화')
    assert service.list_threads('v') == {'threads': []}
    for operation in (lambda: service.for_thread('v', thread['id']),
                      lambda: service.delete_thread('v', thread['id'])):
        with pytest.raises(AppError) as error:
            operation()
        assert error.value.status == 404
    scoped = service.for_thread('u', thread['id'])
    with pytest.raises(AppError) as error:
        await scoped.send('v', {'text': '비공개 대화 조회'})
    assert error.value.status == 404
    assert service.list_threads('u')['threads'][0]['id'] == thread['id']


async def test_delete_removes_only_conversation_not_sources_drafts_or_items(store):
    service = agent(store)
    thread = service.create_thread('u')
    scoped = service.for_thread('u', thread['id'])
    await scoped.send('u', {'text': '보관할 대회 공지'})
    sources, drafts = store.list('sources', 'u'), store.list('drafts', 'u')
    assert service.delete_thread('u', thread['id']) == {'ok': True}
    for collection in ('chat', 'chat-pending', 'chat-threads'):
        assert store.get(collection, thread['id'], 'u') is None
    assert store.list('sources', 'u') == sources
    assert store.list('drafts', 'u') == drafts
    with pytest.raises(AppError) as error:
        scoped.state('u')
    assert error.value.status == 404


async def test_deletion_during_await_never_resurrects_thread_or_plan(store):
    started, release = asyncio.Event(), asyncio.Event()
    async def delayed(source):
        started.set()
        await release.wait()
        return proposal()
    service = agent(store, analyze=delayed)
    thread = service.create_thread('u')
    scoped = service.for_thread('u', thread['id'])
    pending = asyncio.create_task(scoped.send('u', {'text': '분석 중 삭제'}))
    await started.wait()
    service.delete_thread('u', thread['id'])
    release.set()
    with pytest.raises(AppError) as error:
        await pending
    assert error.value.status == 404
    assert store.get('chat', thread['id'], 'u') is None
    assert store.get('chat-pending', thread['id'], 'u') is None
    assert store.list('sources', 'u') == []
    assert store.list('drafts', 'u') == []


async def test_legacy_history_migrates_to_thread_list_without_mixing_new_threads(store):
    service = agent(store, Router({'tool': 'list'}))
    legacy = await service.send('u', {'text': '이전 할 일 조회'})
    assert service.list_threads('u')['threads'][0]['id'] == 'u'
    assert service.for_thread('u', 'u').state('u') == legacy
    new = service.create_thread('u')
    assert service.for_thread('u', new['id']).state('u')['messages'] == []
    assert service.state('u') == legacy


def test_thread_count_and_title_validation(store):
    service = agent(store)
    with pytest.raises(AppError):
        service.create_thread('u', '가' * 81)
    for _ in range(100):
        service.create_thread('u')
    with pytest.raises(AppError) as error:
        service.create_thread('u')
    assert error.value.status == 409


async def test_router_checks_prompt_before_any_llm_request():
    from types import SimpleNamespace
    calls = []
    async def check(text):
        calls.append(text)
        raise AppError('자료 내용을 확인해 주세요.', 400)
    async def token():
        raise AssertionError('LLM must not be invoked before prompt guard')
    vertex = SimpleNamespace(model='configured-model', check_prompt=check, token_provider=token)
    with pytest.raises(AppError):
        await IntentRouter(vertex).route('검사 대상', {})
    assert calls == ['검사 대상']

from test_api import app_client, signed_user, use_session


async def test_thread_http_create_list_reload_send_delete_and_owner_boundaries(app_client):
    async with app_client() as env:
        assert (await env.client.get('/api/chat/threads')).status_code == 401
        session = signed_user(env, 'alice')
        headers = use_session(env, session)
        created = await env.client.post('/api/chat/threads', headers=headers, json={})
        assert created.status_code == 200
        thread_id = created.json()['id']
        empty = await env.client.get('/api/chat', params={'conversationId': thread_id})
        assert empty.status_code == 200 and empty.json()['messages'] == []
        sent = await env.client.post('/api/chat', headers=headers,
            json={'conversationId': thread_id, 'text': '분리된 대화 조회'})
        assert sent.status_code == 200
        assert sent.json()['messages'][0]['text'] == '분리된 대화 조회'
        assert (await env.client.get('/api/chat')).json()['messages'] == []
        listed = (await env.client.get('/api/chat/threads')).json()['threads']
        assert listed[0]['id'] == thread_id and listed[0]['title'] == '분리된 대화 조회'
        assert (await env.client.get('/api/chat', params={'conversationId': thread_id})).json() == sent.json()
        bob_headers = use_session(env, signed_user(env, 'bob'))
        assert (await env.client.get('/api/chat/threads')).json() == {'threads': []}
        assert (await env.client.get('/api/chat', params={'conversationId': thread_id})).status_code == 404
        assert (await env.client.post('/api/chat', headers=bob_headers,
            json={'conversationId': thread_id, 'text': '조회'})).status_code == 404
        assert (await env.client.delete('/api/chat/threads/' + thread_id, headers=bob_headers)).status_code == 404
        headers = use_session(env, session)
        assert (await env.client.delete('/api/chat/threads/' + thread_id, headers=headers)).json() == {'ok': True}
        assert (await env.client.get('/api/chat/threads')).json() == {'threads': []}
        assert (await env.client.get('/api/chat', params={'conversationId': thread_id})).status_code == 404


async def test_thread_creation_rechecks_generation_after_body_read(app_client, monkeypatch):
    from chaenggim import api
    async with app_client() as env:
        headers = use_session(env, signed_user(env, 'alice'))
        original = api.read_json
        async def changed(request):
            value = await original(request)
            env.store.put('users', {'id': 'alice', 'ownerId': 'alice', 'generation': 'changed'})
            return value
        monkeypatch.setattr(api, 'read_json', changed)
        response = await env.client.post('/api/chat/threads', headers=headers, json={})
        # read_json's own generation check is before this injected mutation;
        # creation must also compare to the authenticated request generation.
        assert response.status_code in (401, 409)
        assert env.store.list('chat-threads', 'alice') == []

async def test_legacy_default_send_cannot_resurrect_deleted_migrated_conversation(store):
    service = agent(store, Router({'tool': 'list'}))
    await service.send('u', {'text': '이전 대화'})
    assert service.list_threads('u')['threads'][0]['id'] == 'u'
    other = service.create_thread('u', '남겨둘 대화')
    started, release = asyncio.Event(), asyncio.Event()
    class DelayedRouter:
        async def route(self, text, context):
            started.set()
            await release.wait()
            return {'tool': 'list'}
    service.router = DelayedRouter()
    pending = asyncio.create_task(service.send('u', {'text': '내 할 일 조회'}))
    await started.wait()
    service.delete_thread('u', 'u')
    release.set()
    with pytest.raises(AppError) as error:
        await pending
    assert error.value.status == 404
    assert store.get('chat', 'u', 'u') is None
    assert store.get('chat-pending', 'u', 'u') is None
    assert [thread['id'] for thread in service.list_threads('u')['threads']] == [other['id']]
