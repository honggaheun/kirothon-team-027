import asyncio
import base64
import json
from types import SimpleNamespace

import httpx
import pytest

from chaenggim.domain import AppError, Plans
from chaenggim.google_products import GoogleDrive, GoogleTasks
from chaenggim.intake import MAX_BYTES
from chaenggim.store import Store


class Tokens:
    def __init__(self):
        self.calls = []

    async def access_token(self, user, purpose):
        self.calls.append((user, purpose))
        return 'server-only-token'


@pytest.fixture
def state():
    store = Store(':memory:')
    item = {'id': 'one', 'ownerId': 'u', 'sourceId': 'source', 'kind': 'task',
            'approved': True, 'title': '소풍 준비물 제출', 'version': 1,
            'start': '2026-11-20T16:30:00Z', 'evidence': '준비물은 토요일까지 제출', 'done': False}
    store.put('items', item)
    store.put('sources', {'id': 'source', 'ownerId': 'u', 'title': '소풍 안내',
                          'url': 'https://school.example/notice/1'})
    yield store, item
    store.close()


class TasksServer:
    def __init__(self):
        self.lists = {}
        self.tasks = {}
        self.posts = []
        self.requests = []
        self.lose = None
        self.reject_patch = False
        self.hook = None

    async def __call__(self, request):
        assert request.url.host == 'tasks.googleapis.com'
        assert request.headers['authorization'] == 'Bearer server-only-token'
        self.requests.append(request)
        if self.hook:
            await self.hook(request)
        path = request.url.path
        lists_path = '/tasks/v1/users/@me/lists'
        if path == lists_path:
            if request.method == 'GET':
                return httpx.Response(200, json={'items': list(self.lists.values())})
            body = json.loads(request.content)
            self.posts.append(('list', body))
            remote = {'id': 'list1', 'title': body['title']}
            self.lists['list1'] = remote
            if self.lose == 'list':
                self.lose = None
                raise httpx.ReadTimeout('response lost', request=request)
            return httpx.Response(200, json=remote)
        if path == '/tasks/v1/lists/list1/tasks':
            if request.method == 'GET':
                assert request.url.params['showCompleted'] == 'true'
                assert request.url.params['showHidden'] == 'true'
                return httpx.Response(200, json={'items': list(self.tasks.values())})
            body = json.loads(request.content)
            self.posts.append(('task', body))
            remote = {**body, 'id': 'task1', 'etag': '"v1"',
                      'webViewLink': 'https://tasks.google.com/task/task1'}
            self.tasks['task1'] = remote
            if self.lose == 'task':
                self.lose = None
                raise httpx.ReadTimeout('response lost', request=request)
            return httpx.Response(200, json=remote)
        if path == '/tasks/v1/lists/list1/tasks/task1':
            if request.method == 'GET':
                return httpx.Response(200, json=self.tasks['task1'])
            if self.reject_patch:
                return httpx.Response(412, json={})
            assert request.headers.get('if-match') == self.tasks['task1']['etag']
            self.tasks['task1'] = {**self.tasks['task1'], **json.loads(request.content), 'etag': '"v2"'}
            return httpx.Response(200, json=self.tasks['task1'])
        raise AssertionError((request.method, str(request.url)))


@pytest.mark.parametrize('change,user,status', [({}, 'other', 404), ({'approved': False}, 'u', 409),
                                               ({'kind': 'event'}, 'u', 400)])
async def test_tasks_owner_approval_and_kind_before_remote_calls(state, change, user, status):
    store, item = state
    store.put('items', {**item, **change})
    tokens = Tokens()
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: pytest.fail('unexpected request'))) as client:
        with pytest.raises(AppError) as failure:
            await GoogleTasks(store, tokens, client).sync(user, 'one')
        assert failure.value.status == status
        assert tokens.calls == []


async def test_tasks_create_korean_due_evidence_and_idempotent_retry(state):
    store, _ = state
    server, tokens = TasksServer(), Tokens()
    async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
        service = GoogleTasks(store, tokens, client)
        first = await service.sync('u', 'one')
        assert first['tasks']['taskId'] == 'task1'
        assert first['tasks']['listId'] == 'list1'
        assert first['tasks']['syncedVersion'] == 1
        assert first['tasks']['status'] == 'synced'
        body = server.tasks['task1']
        assert body['due'] == '2026-11-21T00:00:00.000Z'
        assert body['status'] == 'needsAction'
        assert '준비물은 토요일까지 제출' in body['notes']
        assert '2026-11-20T16:30:00Z' in body['notes']
        assert 'https://school.example/notice/1' in body['notes']
        assert 'LERO 항목 ID:' in body['notes']
        assert server.lists['list1']['title'].startswith('LERO [chaenggim:')
        assert 'one' in body['notes'] and '1' in body['notes']
        assert 'server-only-token' not in json.dumps(first)
        assert store.get('tasks', 'u', 'u')['listId'] == 'list1'
        assert await service.sync('u', 'one') == first
        assert [kind for kind, _ in server.posts] == ['list', 'task']
        assert tokens.calls == [('u', 'tasks')]


async def test_tasks_complete_and_reopen_update_existing_remote(state):
    store, _ = state
    server = TasksServer()
    async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
        service = GoogleTasks(store, Tokens(), client)
        await service.sync('u', 'one')
        Plans(store).complete('u', 'one', True)
        done = await service.sync('u', 'one')
        assert server.tasks['task1']['status'] == 'completed'
        assert done['tasks']['syncedVersion'] == 2
        Plans(store).complete('u', 'one', False)
        reopened = await service.sync('u', 'one')
        assert server.tasks['task1']['status'] == 'needsAction'
        assert server.tasks['task1']['completed'] is None
        assert reopened['tasks']['syncedVersion'] == 3
        assert len(server.posts) == 2


@pytest.mark.parametrize('lost', ['list', 'task'])
async def test_tasks_lost_create_response_reconciles_without_duplicate(state, lost):
    store, _ = state
    server = TasksServer()
    server.lose = lost
    async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
        service = GoogleTasks(store, Tokens(), client)
        with pytest.raises(AppError):
            await service.sync('u', 'one')
        first = await service.sync('u', 'one')
        assert first['tasks']['status'] == 'synced'
        assert [kind for kind, _ in server.posts] == ['list', 'task']


async def test_tasks_uncertain_create_without_visible_remote_does_not_retry_insert(state):
    store, _ = state
    posts = 0
    async def handler(request):
        nonlocal posts
        if request.method == 'GET':
            return httpx.Response(200, json={'items': []})
        posts += 1
        raise httpx.ReadTimeout('unknown outcome', request=request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = GoogleTasks(store, Tokens(), client)
        with pytest.raises(AppError):
            await service.sync('u', 'one')
        with pytest.raises(AppError) as failure:
            await service.sync('u', 'one')
        assert failure.value.status == 409
        assert posts == 1


async def test_tasks_patch_conflict_keeps_last_synced_version(state):
    store, _ = state
    server = TasksServer()
    async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
        service = GoogleTasks(store, Tokens(), client)
        await service.sync('u', 'one')
        Plans(store).complete('u', 'one', True)
        server.reject_patch = True
        with pytest.raises(AppError) as failure:
            await service.sync('u', 'one')
        assert failure.value.status == 409
        assert store.get('items', 'one', 'u')['tasks']['syncedVersion'] == 1


async def test_tasks_external_edit_conflicts_before_patch(state):
    store, _ = state
    server = TasksServer()
    async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
        service = GoogleTasks(store, Tokens(), client)
        await service.sync('u', 'one')
        server.tasks['task1'].update(title='Google에서 바꾼 제목', etag='"external"')
        Plans(store).complete('u', 'one', True)
        with pytest.raises(AppError) as failure:
            await service.sync('u', 'one')
        assert failure.value.status == 409
        assert not any(request.method == 'PATCH' for request in server.requests)
        assert store.get('items', 'one', 'u')['tasks']['syncedVersion'] == 1


async def test_tasks_lost_patch_response_reconciles_successful_update(state):
    store, _ = state
    server = TasksServer()
    lose = False
    async def handler(request):
        nonlocal lose
        response = await server(request)
        if request.method == 'PATCH' and lose:
            lose = False
            raise httpx.ReadTimeout('response lost', request=request)
        return response
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = GoogleTasks(store, Tokens(), client)
        await service.sync('u', 'one')
        Plans(store).complete('u', 'one', True)
        lose = True
        with pytest.raises(AppError):
            await service.sync('u', 'one')
        assert store.get('items', 'one', 'u')['tasks']['syncedVersion'] == 1
        result = await service.sync('u', 'one')
        assert result['tasks']['syncedVersion'] == 2
        assert sum(request.method == 'PATCH' for request in server.requests) == 1


async def test_tasks_reconcile_searches_all_list_and_task_pages(state):
    store, item = state
    marker, title = '[chaenggim:unique-item]', 'LERO [chaenggim:unique-list]'
    store.put('tasks', {'id': 'u', 'ownerId': 'u', 'marker': 'unique-list', 'title': title,
                        'createAttempted': True})
    store.put('items', {**item, 'tasks': {'marker': marker, 'createAttempted': True}})
    calls = []
    async def handler(request):
        calls.append(request)
        assert request.method != 'POST'
        if request.method == 'PATCH':
            return httpx.Response(200, json={**json.loads(request.content), 'id': 'old-task', 'etag': '"v2"'})
        if request.url.path.endswith('/users/@me/lists'):
            if 'pageToken' not in request.url.params:
                return httpx.Response(200, json={'items': [{'id': 'unrelated', 'title': '다른 목록'}], 'nextPageToken': 'lists-page2'})
            assert request.url.params['pageToken'] == 'lists-page2'
            return httpx.Response(200, json={'items': [{'id': 'old-list', 'title': title}]})
        if 'pageToken' not in request.url.params:
            return httpx.Response(200, json={'items': [], 'nextPageToken': 'tasks-page2'})
        assert request.url.params['pageToken'] == 'tasks-page2'
        return httpx.Response(200, json={'items': [{'id': 'old-task', 'title': '예전 제목',
                                                  'notes': marker, 'status': 'needsAction', 'etag': '"v1"'}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleTasks(store, Tokens(), client).sync('u', 'one')
    assert result['tasks']['taskId'] == 'old-task' and result['tasks']['listId'] == 'old-list'
    assert result['tasks']['status'] == 'synced'
    assert len(calls) == 5


async def test_tasks_failed_definitive_insert_can_retry_after_permission_is_fixed(state):
    store, _ = state
    server = TasksServer()
    reject = True
    async def handler(request):
        nonlocal reject
        if request.method == 'POST' and reject:
            reject = False
            return httpx.Response(403, json={})
        return await server(request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = GoogleTasks(store, Tokens(), client)
        with pytest.raises(AppError) as failure:
            await service.sync('u', 'one')
        assert failure.value.status == 403
        assert (await service.sync('u', 'one'))['tasks']['status'] == 'synced'
        assert len(server.posts) == 2


async def test_tasks_source_app_link_and_empty_due_are_preserved(state):
    store, item = state
    store.put('items', {**item, 'start': None})
    tokens, server = Tokens(), TasksServer()
    tokens.settings = SimpleNamespace(origin='https://chaenggim.example')
    async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
        await GoogleTasks(store, tokens, client).sync('u', 'one')
    assert 'LERO 자료: https://chaenggim.example/#source/source' in server.tasks['task1']['notes']
    assert server.tasks['task1']['due'] is None


async def test_tasks_concurrent_sync_claim_prevents_duplicate_posts(state):
    store, _ = state
    server = TasksServer()
    entered, finish = asyncio.Event(), asyncio.Event()
    async def hook(request):
        if request.method == 'POST' and request.url.path.endswith('/users/@me/lists'):
            entered.set()
            await finish.wait()
    server.hook = hook
    async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
        service = GoogleTasks(store, Tokens(), client)
        first = asyncio.create_task(service.sync('u', 'one'))
        await entered.wait()
        try:
            with pytest.raises(AppError) as failure:
                await service.sync('u', 'one')
            assert failure.value.status == 409
        finally:
            finish.set()
        assert (await first)['tasks']['status'] == 'synced'
        assert len(server.posts) == 2


async def test_tasks_account_deleted_during_remote_call_never_resurrects_documents(state):
    store, _ = state
    server = TasksServer()
    async def hook(request):
        if request.method == 'POST' and request.url.path.endswith('/tasks'):
            store.delete('items', 'one', 'u')
            store.delete('tasks', 'u', 'u')
    server.hook = hook
    async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
        with pytest.raises(AppError):
            await GoogleTasks(store, Tokens(), client).sync('u', 'one')
    assert store.get('items', 'one', 'u') is None
    assert store.get('tasks', 'u', 'u') is None


async def test_tasks_version_changed_during_post_preserves_current_item_and_remote_id(state):
    store, _ = state
    server = TasksServer()
    async def hook(request):
        if request.method == 'POST' and request.url.path.endswith('/tasks'):
            current = store.get('items', 'one', 'u')
            store.put('items', {**current, 'title': '새 제목', 'version': 2})
    server.hook = hook
    async with httpx.AsyncClient(transport=httpx.MockTransport(server)) as client:
        with pytest.raises(AppError) as failure:
            await GoogleTasks(store, Tokens(), client).sync('u', 'one')
        assert failure.value.status == 409
    current = store.get('items', 'one', 'u')
    assert current['title'] == '새 제목' and current['version'] == 2
    assert current['tasks']['taskId'] == 'task1'
    assert current['tasks']['syncedVersion'] == 1
    assert current['tasks']['status'] == 'pending'


async def test_drive_list_escapes_query_filters_directories_and_returns_safe_metadata(state):
    store, _ = state
    tokens = Tokens()
    async def handler(request):
        assert request.url.host == 'www.googleapis.com'
        assert request.url.params['pageSize'] == '20'
        query = request.url.params['q']
        assert 'trashed = false' in query
        assert "name contains 'O\\'Brien\\\\term'" in query
        assert 'application/vnd.google-apps.folder' not in query
        assert 'application/pdf' in query and 'application/vnd.google-apps.document' in query
        assert request.url.params['pageToken'] == 'next+token'
        return httpx.Response(200, json={'files': [
            {'id': 'pdf1', 'name': '안내.pdf', 'mimeType': 'application/pdf', 'size': '30', 'webViewLink': 'https://drive.google.com/file/d/pdf1/view'},
            {'id': 'folder', 'name': '폴더', 'mimeType': 'application/vnd.google-apps.folder'},
            {'id': 'trash', 'name': '삭제.txt', 'mimeType': 'text/plain', 'trashed': True}],
            'nextPageToken': 'another'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleDrive(store, tokens, client).list_files('u', "O'Brien\\term", 'next+token')
    assert [file['id'] for file in result['files']] == ['pdf1']
    assert result['nextPageToken'] == 'another'
    assert tokens.calls == [('u', 'drive')]
    assert 'server-only-token' not in json.dumps(result)


@pytest.mark.parametrize('mime,data,kind', [
    ('text/plain', '현장 학습 준비물을 금요일까지 제출하세요.'.encode(), 'text'),
    ('application/pdf', b'%PDF-1.7\nreal pdf header', 'file'),
    ('image/png', b'\x89PNG\r\n\x1a\nimage content', 'image'),
    ('application/vnd.google-apps.document', 'Google 문서 내용입니다.'.encode(), 'text')])
async def test_drive_import_normalizes_real_file_bytes_and_source_link(state, mime, data, kind):
    store, _ = state
    calls = []
    async def handler(request):
        calls.append(request)
        assert request.url.host == 'www.googleapis.com'
        assert request.headers['authorization'] == 'Bearer server-only-token'
        if 'fields' in request.url.params:
            return httpx.Response(200, json={'id': 'file1', 'name': '원본 공지', 'mimeType': mime,
                                           'size': str(len(data)), 'webViewLink': 'https://drive.google.com/file/d/file1/view'})
        if mime == 'application/vnd.google-apps.document':
            assert request.url.path.endswith('/file1/export')
            assert request.url.params['mimeType'] == 'text/plain'
        else:
            assert request.url.params['alt'] == 'media'
        return httpx.Response(200, content=data)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleDrive(store, Tokens(), client).import_file('u', 'file1')
    assert len(calls) == 2
    assert result['kind'] == kind
    assert result['title'] == '원본 공지' and result['driveFileId'] == 'file1'
    assert result['url'] == 'https://drive.google.com/file/d/file1/view'
    if kind == 'text':
        assert result['text'] == data.decode()
    else:
        assert base64.b64decode(result['data']) == data
    saved = Plans(store).add_source('u', result)
    assert saved['ownerId'] == 'u'


@pytest.mark.parametrize('metadata', [
    {'mimeType': 'application/vnd.google-apps.folder'},
    {'mimeType': 'application/pdf', 'size': str(MAX_BYTES + 1)},
    {'mimeType': 'text/plain', 'size': '12', 'trashed': True},
    {'mimeType': 'application/pdf', 'size': 'invalid'}])
async def test_drive_rejects_unsupported_trashed_and_oversize_before_download(state, metadata):
    store, _ = state
    requests = []
    async def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'id': 'file1', 'name': '안내', **metadata})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AppError):
            await GoogleDrive(store, Tokens(), client).import_file('u', 'file1')
    assert len(requests) == 1


class Chunks(httpx.AsyncByteStream):
    def __init__(self):
        self.count = 0

    async def __aiter__(self):
        for _ in range(10):
            self.count += 1
            yield b'x' * (1024 * 1024)


async def test_drive_streaming_bound_does_not_trust_metadata_or_read_entire_body(state):
    store, _ = state
    chunks = Chunks()
    async def handler(request):
        if 'fields' in request.url.params:
            return httpx.Response(200, json={'id': 'file1', 'name': '작아보이는 파일', 'mimeType': 'text/plain', 'size': '1'})
        return httpx.Response(200, stream=chunks)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AppError, match='4MB'):
            await GoogleDrive(store, Tokens(), client).import_file('u', 'file1')
    assert chunks.count <= 5


async def test_drive_rejects_spoofed_pdf_bytes(state):
    store, _ = state
    async def handler(request):
        if 'fields' in request.url.params:
            return httpx.Response(200, json={'id': 'file1', 'name': 'fake.pdf', 'mimeType': 'application/pdf', 'size': '5'})
        return httpx.Response(200, content=b'hello')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AppError):
            await GoogleDrive(store, Tokens(), client).import_file('u', 'file1')


@pytest.mark.parametrize('status', [401, 403, 404, 503])
async def test_drive_remote_errors_are_app_errors(state, status):
    store, _ = state
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(status, json={'error': 'private upstream details'}))) as client:
        with pytest.raises(AppError) as failure:
            await GoogleDrive(store, Tokens(), client).import_file('u', 'file1')
    assert failure.value.status == (502 if status == 503 else status)
    assert 'private upstream details' not in str(failure.value)


@pytest.mark.parametrize('file_id', ['../x', 'https://evil.example', '', 'a' * 257, None])
async def test_drive_rejects_bad_file_id_before_oauth(state, file_id):
    store, _ = state
    tokens = Tokens()
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: pytest.fail('unexpected request'))) as client:
        with pytest.raises(AppError):
            await GoogleDrive(store, tokens, client).import_file('u', file_id)
    assert tokens.calls == []


async def test_drive_rejects_bad_query_and_page_token_before_oauth(state):
    store, _ = state
    tokens = Tokens()
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: pytest.fail('unexpected request'))) as client:
        service = GoogleDrive(store, tokens, client)
        for query, page_token in [('a' * 201, None), ('ok', 'a' * 2049), ('ok', '\nsecret')]:
            with pytest.raises(AppError):
                await service.list_files('u', query, page_token)
    assert tokens.calls == []


async def test_drive_redirect_never_forwards_token_to_another_host(state):
    store, _ = state
    calls = []
    async def handler(request):
        calls.append(request)
        assert request.url.host == 'www.googleapis.com'
        if 'fields' in request.url.params:
            return httpx.Response(200, json={'id': 'file1', 'name': '안내', 'mimeType': 'text/plain', 'size': '5'})
        return httpx.Response(302, headers={'location': 'https://evil.example/steal'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
        with pytest.raises(AppError):
            await GoogleDrive(store, Tokens(), client).import_file('u', 'file1')
    assert len(calls) == 2


async def test_drive_doc_without_size_exports_and_broken_view_link_is_ignored(state):
    store, _ = state
    async def handler(request):
        if 'fields' in request.url.params:
            return httpx.Response(200, json={'id': 'file1', 'name': '문서', 'mimeType': 'application/vnd.google-apps.document',
                                           'webViewLink': 'https://[broken'})
        return httpx.Response(200, content='원문 내용입니다.'.encode())
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleDrive(store, Tokens(), client).import_file('u', 'file1')
    assert result['kind'] == 'text'
    assert result['url'] == 'https://drive.google.com/file/d/file1/view'


async def test_drive_rejects_utf8_invalid_text(state):
    store, _ = state
    async def handler(request):
        if 'fields' in request.url.params:
            return httpx.Response(200, json={'id': 'file1', 'name': '안내.txt', 'mimeType': 'text/plain', 'size': '3'})
        return httpx.Response(200, content=b'\xff\xfe\xfa')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AppError, match='UTF-8'):
            await GoogleDrive(store, Tokens(), client).import_file('u', 'file1')


async def test_drive_missing_permission_does_not_reach_google_or_expose_token(state):
    store, _ = state
    class Denied:
        async def access_token(self, user, purpose):
            raise AppError('Google Drive를 연결해 주세요.', 409)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: pytest.fail('unexpected request'))) as client:
        with pytest.raises(AppError) as failure:
            await GoogleDrive(store, Denied(), client).list_files('u')
    assert failure.value.status == 409


async def test_tasks_list_reads_actual_lists_and_returns_only_safe_matching_metadata():
    tokens, calls = Tokens(), []

    class NoStore:
        def __getattr__(self, name):
            raise AssertionError('Read-only Tasks listing must not access the local store')

    async def handler(request):
        calls.append(request)
        assert request.method == 'GET' and request.url.host == 'tasks.googleapis.com'
        assert request.headers['authorization'] == 'Bearer server-only-token'
        assert 'notes' not in request.url.params.get('fields', '')
        if request.url.path.endswith('/users/@me/lists'):
            return httpx.Response(200, json={'items': [{'id': 'personal', 'title': '개인'}, {'id': 'work', 'title': '업무'}]})
        assert request.url.params['showCompleted'] == 'false'
        assert request.url.params['showHidden'] == 'false'
        title = '개인 준비' if '/personal/' in request.url.path else '발표 준비'
        return httpx.Response(200, json={'items': [
            {'id': title, 'title': title, 'due': '2026-11-21T00:00:00.000Z', 'status': 'needsAction',
             'updated': '2026-11-14T00:00:00.000Z', 'webViewLink': 'https://tasks.google.com/task/example',
             'notes': 'private notes', 'unknown': 'private field'},
            {'id': 'done', 'title': '준비 완료', 'status': 'completed'},
            {'id': 'hidden', 'title': '준비 숨김', 'status': 'needsAction', 'hidden': True},
            {'id': 'deleted', 'title': '준비 삭제', 'status': 'needsAction', 'deleted': True},
            {'id': 'unrelated', 'title': '다른 업무', 'status': 'needsAction', 'notes': '준비'}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleTasks(NoStore(), tokens, client).list_items('u', '준비')
    assert tokens.calls == [('u', 'tasks')]
    assert result['truncated'] is False
    assert [(item['title'], item['listTitle']) for item in result['items']] == [('개인 준비', '개인'), ('발표 준비', '업무')]
    assert set(result['items'][0]) == {'id', 'title', 'due', 'status', 'updated', 'webViewLink', 'listTitle'}
    assert 'private' not in json.dumps(result)
    assert len(calls) == 3


async def test_tasks_list_query_is_literal_title_filter_not_api_or_regex_query(state):
    store, _ = state
    query = "O'Brien\\[] .* or status='completed'"
    async def handler(request):
        assert 'q' not in request.url.params
        assert query not in str(request.url)
        if request.url.path.endswith('/users/@me/lists'):
            return httpx.Response(200, json={'items': [{'id': 'one/list', 'title': '목록'}]})
        assert '/one%2Flist/tasks' in request.url.raw_path.decode()
        return httpx.Response(200, json={'items': [
            {'id': 'literal', 'title': '준비 ' + query, 'status': 'needsAction'},
            {'id': 'not-literal', 'title': 'OBrien arbitrary content', 'status': 'needsAction'},
            {'id': 'notes-only', 'title': '무관', 'notes': query, 'status': 'needsAction'}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleTasks(store, Tokens(), client).list_items('u', query)
    assert [item['id'] for item in result['items']] == ['literal']


async def test_tasks_list_follows_bounded_list_and_task_pagination(state):
    store, _ = state
    calls = []
    async def handler(request):
        calls.append(request)
        if request.url.path.endswith('/users/@me/lists'):
            if 'pageToken' not in request.url.params:
                return httpx.Response(200, json={'items': [{'id': 'a', 'title': 'A'}], 'nextPageToken': 'list-page2'})
            assert request.url.params['pageToken'] == 'list-page2'
            return httpx.Response(200, json={'items': [{'id': 'b', 'title': 'B'}]})
        prefix = 'a' if '/a/' in request.url.path else 'b'
        if 'pageToken' not in request.url.params:
            return httpx.Response(200, json={'items': [{'id': prefix + '1', 'title': '첫 항목', 'status': 'needsAction'}],
                                           'nextPageToken': 'task-page2'})
        assert request.url.params['pageToken'] == 'task-page2'
        return httpx.Response(200, json={'items': [{'id': prefix + '2', 'title': '둘째 항목', 'status': 'needsAction'}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleTasks(store, Tokens(), client).list_items('u')
    assert [item['id'] for item in result['items']] == ['a1', 'a2', 'b1', 'b2']
    assert result['truncated'] is False and len(calls) == 6


async def test_tasks_list_limits_to_ten_lists_and_reports_truncated(state):
    store, _ = state
    task_lists = []
    async def handler(request):
        if request.url.path.endswith('/users/@me/lists'):
            assert request.url.params['maxResults'] == '10'
            assert 'pageToken' not in request.url.params
            return httpx.Response(200, json={'items': [{'id': str(i), 'title': str(i)} for i in range(10)],
                                           'nextPageToken': 'more-lists'})
        task_lists.append(request.url.path)
        return httpx.Response(200, json={'items': []})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleTasks(store, Tokens(), client).list_items('u')
    assert len(task_lists) == 10 and result == {'items': [], 'truncated': True}


async def test_tasks_list_limits_twenty_tasks_per_list_even_when_query_matches_nothing(state):
    store, _ = state
    calls = []
    async def handler(request):
        calls.append(request)
        if request.url.path.endswith('/users/@me/lists'):
            return httpx.Response(200, json={'items': [{'id': 'a', 'title': 'A'}]})
        assert request.url.params['maxResults'] == '20'
        assert 'pageToken' not in request.url.params
        return httpx.Response(200, json={'items': [{'id': str(i), 'title': '다른 일', 'status': 'needsAction'} for i in range(20)],
                                       'nextPageToken': 'more-tasks'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleTasks(store, Tokens(), client).list_items('u', '준비')
    assert result == {'items': [], 'truncated': True} and len(calls) == 2


async def test_tasks_list_caps_returned_items_at_fifty_and_stops_fetching(state):
    store, _ = state
    lists_read = []
    async def handler(request):
        if request.url.path.endswith('/users/@me/lists'):
            return httpx.Response(200, json={'items': [{'id': str(i), 'title': str(i)} for i in range(10)]})
        list_id = request.url.path.split('/')[-2]
        lists_read.append(list_id)
        return httpx.Response(200, json={'items': [{'id': list_id + '-' + str(i), 'title': '준비', 'status': 'needsAction'} for i in range(20)]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleTasks(store, Tokens(), client).list_items('u')
    assert len(result['items']) == 50 and result['truncated'] is True
    assert lists_read == ['0', '1', '2']


@pytest.mark.parametrize('empty_pages', ['lists', 'tasks'])
async def test_tasks_list_stops_even_when_api_returns_empty_pages_with_more_tokens(state, empty_pages):
    store, _ = state
    calls = []
    async def handler(request):
        calls.append(request)
        if empty_pages == 'tasks' and request.url.path.endswith('/users/@me/lists'):
            return httpx.Response(200, json={'items': [{'id': 'a', 'title': 'A'}]})
        return httpx.Response(200, json={'items': [], 'nextPageToken': 'page-' + str(len(calls))})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleTasks(store, Tokens(), client).list_items('u')
    assert result == {'items': [], 'truncated': True}
    assert len(calls) <= (3 if empty_pages == 'lists' else 4)


@pytest.mark.parametrize('status', [401, 403, 404, 503])
@pytest.mark.parametrize('phase', ['lists', 'tasks'])
async def test_tasks_list_surfaces_google_errors_as_app_errors(state, status, phase):
    store, _ = state
    async def handler(request):
        if phase == 'tasks' and request.url.path.endswith('/users/@me/lists'):
            return httpx.Response(200, json={'items': [{'id': 'a', 'title': 'A'}]})
        return httpx.Response(status, json={'error': 'private details'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AppError) as failure:
            await GoogleTasks(store, Tokens(), client).list_items('u')
    assert failure.value.status == (502 if status == 503 else status)
    assert 'private details' not in str(failure.value)


@pytest.mark.parametrize('query', [None, 1, 'a' * 201, 'bad\nquery'])
async def test_tasks_list_validates_query_before_oauth(state, query):
    store, _ = state
    tokens = Tokens()
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: pytest.fail('unexpected request'))) as client:
        with pytest.raises(AppError):
            await GoogleTasks(store, tokens, client).list_items('u', query)
    assert tokens.calls == []


async def test_tasks_list_uses_only_the_requesting_users_oauth_token(state):
    store, _ = state
    class OwnedTokens:
        async def access_token(self, user, purpose):
            assert purpose == 'tasks'
            if user != 'u':
                raise AppError('연결 권한이 없어요.', 403)
            return 'owner-token'
    calls = []
    async def handler(request):
        calls.append(request)
        assert request.headers['authorization'] == 'Bearer owner-token'
        return httpx.Response(200, json={'items': []})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = GoogleTasks(store, OwnedTokens(), client)
        with pytest.raises(AppError) as failure:
            await service.list_items('other')
        assert failure.value.status == 403 and calls == []
        assert await service.list_items('u') == {'items': [], 'truncated': False}


async def test_tasks_list_exact_fifty_items_are_complete_without_more_pages(state):
    store, _ = state
    async def handler(request):
        if request.url.path.endswith('/users/@me/lists'):
            return httpx.Response(200, json={'items': [{'id': str(i), 'title': str(i)} for i in range(3)]})
        list_id = request.url.path.split('/')[-2]
        count = 10 if list_id == '2' else 20
        return httpx.Response(200, json={'items': [{'id': str(i), 'title': '준비', 'status': 'needsAction'} for i in range(count)]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleTasks(store, Tokens(), client).list_items('u')
    assert len(result['items']) == 50 and result['truncated'] is False


async def test_tasks_list_casefold_filter_omits_untrusted_view_link_and_extra_fields(state):
    store, _ = state
    async def handler(request):
        if request.url.path.endswith('/users/@me/lists'):
            return httpx.Response(200, json={'items': [{'id': 'a', 'title': 'A'}]})
        return httpx.Response(200, json={'items': [{'id': 'task', 'title': 'LERO 준비', 'status': 'needsAction',
                                                  'webViewLink': 'https://evil.example/steal',
                                                  'notes': 'private', 'access_token': 'must-not-return'}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await GoogleTasks(store, Tokens(), client).list_items('u', 'lero')
    assert [item['title'] for item in result['items']] == ['LERO 준비']
    assert 'webViewLink' not in result['items'][0]
    assert 'must-not-return' not in json.dumps(result)
