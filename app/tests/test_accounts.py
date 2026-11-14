import importlib
from contextlib import contextmanager
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest

from chaenggim.auth import OAuth
from chaenggim.store import Store


OWNED_COLLECTIONS = (
    'users', 'sources', 'drafts', 'items', 'google', 'gmail-seen',
    'gmail-settings', 'calendar', 'tasks', 'chat', 'chat-pending', 'drive',
    'tasks-claims', 'chat-threads',
)


def accounts(store, client):
    try:
        module = importlib.import_module('chaenggim.accounts')
    except ModuleNotFoundError as error:
        if error.name != 'chaenggim.accounts':
            raise
        module = None
    assert module is not None, 'Account deletion service is missing'
    oauth = OAuth(store, SimpleNamespace(encryption_key=b'5' * 32), client)
    return module.Accounts(store, oauth, client), oauth


@pytest.fixture
def store():
    value = Store(':memory:')
    yield value
    value.close()


async def test_delete_removes_owned_data_and_all_bound_sessions_only(store):
    other_documents = {}
    for collection in OWNED_COLLECTIONS:
        own_id = 'u' if collection in ('users', 'google') else collection + '-u'
        other_id = 'v' if collection in ('users', 'google') else collection + '-v'
        store.put(collection, {'id': own_id, 'ownerId': 'u', 'text': 'private'})
        other_documents[collection] = {'id': other_id, 'ownerId': 'v', 'text': 'keep'}
        store.put(collection, other_documents[collection])
    for collection in ('sessions', 'oauth'):
        store.put(collection, {'id': collection + '-one', 'ownerId': '@system', 'userId': 'u'})
        store.put(collection, {'id': collection + '-two', 'ownerId': '@system', 'userId': 'u'})
        store.put(collection, {'id': collection + '-other', 'ownerId': '@system', 'userId': 'v'})
    store.put('oauth', {'id': 'unbound-login', 'ownerId': '@system', 'userId': None})

    def no_external_request(request):
        pytest.fail('Deletion must not modify Google originals or request absent tokens')

    async with httpx.AsyncClient(transport=httpx.MockTransport(no_external_request)) as client:
        service, _ = accounts(store, client)
        assert await service.delete('u') == {'ok': True, 'cleanupPending': False}

    for collection in OWNED_COLLECTIONS:
        assert store.list(collection, 'u') == []
        assert store.list(collection, 'v') == [other_documents[collection]]
    for collection in ('sessions', 'oauth'):
        assert store.get(collection, collection + '-one', '@system') is None
        assert store.get(collection, collection + '-two', '@system') is None
        assert store.get(collection, collection + '-other', '@system')['userId'] == 'v'
    assert store.get('oauth', 'unbound-login', '@system')['userId'] is None


async def test_delete_clears_all_owned_threads_preserving_other_user_and_google_items(store):
    requests = []
    thread_collections = ('chat-threads', 'chat', 'chat-pending')
    own_threads = ('8fa3bb3e-6105-48e2-97fb-1aa30f307672',
                   'b4d2f070-60ce-4872-8143-3277307959df')
    other_thread = 'e483375e-fc70-4c3a-b6be-1176db683290'
    preserved = {}
    for collection in thread_collections:
        for index, thread_id in enumerate(own_threads):
            store.put(collection, {'id': thread_id, 'ownerId': 'u',
                                   'title': 'private thread', 'draftId': 'draft-' + str(index),
                                   'messages': [{'role': 'user', 'text': 'private conversation'}]})
        preserved[collection] = {'id': other_thread, 'ownerId': 'v', 'title': 'keep',
                                 'draftId': 'other-draft', 'messages': []}
        store.put(collection, preserved[collection])
    store.put('items', {'id': 'own-synced-item', 'ownerId': 'u',
                        'calendar': {'calendarId': 'google-calendar', 'eventId': 'google-event'},
                        'tasks': {'listId': 'google-list', 'taskId': 'google-task'}})

    def handler(request):
        requests.append(request)
        assert request.method == 'POST'
        assert str(request.url) == 'https://oauth2.googleapis.com/revoke'
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service, oauth = accounts(store, client)
        store.put('google', {'id': 'u', 'ownerId': 'u',
                             'tokens': oauth.seal({'refresh_token': 'test-refresh'}, 'u')})
        assert await service.delete('u') == {'ok': True, 'cleanupPending': False}

    for collection in thread_collections:
        assert store.list(collection, 'u') == []
        assert store.list(collection, 'v') == [preserved[collection]]
    assert store.list('items', 'u') == []
    assert [(request.method, str(request.url)) for request in requests] == [
        ('POST', 'https://oauth2.googleapis.com/revoke')]


@pytest.mark.parametrize('tokens,expected', [
    ({'refresh_token': 'refresh-secret', 'access_token': 'access-secret'}, 'refresh-secret'),
    ({'access_token': 'access-secret'}, 'access-secret'),
])
async def test_delete_revokes_token_after_local_data_is_gone(store, tokens, expected):
    requests = []
    local_state_at_revoke = []

    def handler(request):
        requests.append(request)
        local_state_at_revoke.append((store.get('users', 'u', 'u'), store.list('sources', 'u')))
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service, oauth = accounts(store, client)
        store.put('users', {'id': 'u', 'ownerId': 'u'})
        store.put('sources', {'id': 'private', 'ownerId': 'u'})
        store.put('google', {'id': 'u', 'ownerId': 'u', 'tokens': oauth.seal(tokens, 'u')})
        assert await service.delete('u') == {'ok': True, 'cleanupPending': False}

    assert len(requests) == 1
    assert local_state_at_revoke == [(None, [])]
    request = requests[0]
    assert request.method == 'POST'
    assert str(request.url) == 'https://oauth2.googleapis.com/revoke'
    assert request.headers['content-type'].startswith('application/x-www-form-urlencoded')
    assert parse_qs(request.content.decode()) == {'token': [expected]}
    assert all(0 < value <= 5 for value in request.extensions['timeout'].values())


@pytest.mark.parametrize('failure', ['status', 'timeout'])
async def test_revoke_failure_does_not_keep_local_account_data(store, caplog, failure):
    def handler(request):
        if failure == 'timeout':
            raise httpx.ReadTimeout('unavailable', request=request)
        return httpx.Response(503)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service, oauth = accounts(store, client)
        store.put('users', {'id': 'u', 'ownerId': 'u'})
        store.put('google', {'id': 'u', 'ownerId': 'u', 'tokens': oauth.seal({'refresh_token': 'refresh-secret'}, 'u')})
        store.put('sessions', {'id': 'session', 'ownerId': '@system', 'userId': 'u'})
        assert await service.delete('u') == {'ok': True, 'cleanupPending': False}

    assert store.get('users', 'u', 'u') is None
    assert store.get('google', 'u', 'u') is None
    assert store.get('sessions', 'session', '@system') is None
    assert 'refresh-secret' not in caplog.text


async def test_unreadable_saved_tokens_do_not_block_deletion(store):
    def no_external_request(request):
        pytest.fail('Unreadable credentials must not be sent to Google')

    async with httpx.AsyncClient(transport=httpx.MockTransport(no_external_request)) as client:
        service, _ = accounts(store, client)
        store.put('google', {'id': 'u', 'ownerId': 'u', 'tokens': 'unreadable'})
        assert await service.delete('u') == {'ok': True, 'cleanupPending': False}
    assert store.list('google', 'u') == []


async def test_delete_is_idempotent_and_account_can_start_empty_again(store):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200))) as client:
        service, _ = accounts(store, client)
        store.put('users', {'id': 'u', 'ownerId': 'u', 'generation': 'old'})
        store.put('items', {'id': 'old-item', 'ownerId': 'u'})
        assert await service.delete('u') == {'ok': True, 'cleanupPending': False}
        assert await service.delete('u') == {'ok': True, 'cleanupPending': False}
        store.put('users', {'id': 'u', 'ownerId': 'u', 'generation': 'new'})
    assert store.get('users', 'u', 'u')['generation'] == 'new'
    assert store.list('items', 'u') == []


async def test_all_reads_happen_in_transaction_before_any_deletion():
    class ReadFirstStore(Store):
        checking = False
        active = False
        wrote = False

        @contextmanager
        def transaction(self):
            with super().transaction():
                self.active = True
                self.wrote = False
                try:
                    yield
                finally:
                    self.active = False

        def get(self, *args):
            if self.checking:
                assert self.active and not self.wrote, 'Read must precede transaction writes'
            return super().get(*args)

        def list(self, *args):
            if self.checking:
                assert self.active and not self.wrote, 'Read must precede transaction writes'
            return super().list(*args)

        def delete(self, *args):
            assert self.active
            self.wrote = True
            return super().delete(*args)

    store = ReadFirstStore(':memory:')
    try:
        store.put('users', {'id': 'u', 'ownerId': 'u'})
        store.put('items', {'id': 'item', 'ownerId': 'u'})
        store.put('sessions', {'id': 'session', 'ownerId': '@system', 'userId': 'u'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200))) as client:
            service, _ = accounts(store, client)
            store.checking = True
            assert await service.delete('u') == {'ok': True, 'cleanupPending': False}
            store.checking = False
        assert store.list('users', 'u') == []
        assert store.list('items', 'u') == []
    finally:
        store.close()


@pytest.mark.parametrize('failed', [False, True])
async def test_private_cloud_file_cleanup_reports_pending_without_restoring_data(caplog, failed):
    class CloudFilesStore(Store):
        def __init__(self):
            super().__init__(':memory:')
            self.deleted_files = []

        def delete_user_files(self, user):
            assert self.get('users', user, user) is None
            self.deleted_files.append(user)
            if failed:
                raise RuntimeError('private attachment details')

    store = CloudFilesStore()
    try:
        store.put('users', {'id': 'u', 'ownerId': 'u'})
        store.put('sources', {'id': 'source', 'ownerId': 'u', '_blob': 'private/u/file'})
        store.put('users', {'id': 'v', 'ownerId': 'v'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200))) as client:
            service, _ = accounts(store, client)
            assert await service.delete('u') == {'ok': True, 'cleanupPending': failed}
        assert store.deleted_files == ['u']
        assert store.get('users', 'u', 'u') is None
        assert store.list('sources', 'u') == []
        assert store.get('users', 'v', 'v')['id'] == 'v'
        assert 'private attachment details' not in caplog.text
    finally:
        store.close()
