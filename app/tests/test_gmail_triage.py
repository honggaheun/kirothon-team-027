import asyncio
import base64
import json

import httpx
import pytest

from chaenggim.domain import AppError, Plans
from chaenggim.gmail import Gmail
from chaenggim.store import Store


class Tokens:
    async def access_token(self, user, purpose):
        assert (user, purpose) == ('u', 'gmail')
        return 'server-token'


@pytest.fixture
def store():
    value = Store(':memory:')
    value.put('users', {'id': 'u', 'ownerId': 'u', 'generation': 'original'})
    value.put('gmail-settings', {'id': 'u', 'ownerId': 'u', 'enabled': True, 'query': '공지'})
    yield value
    value.close()


def mail(message_id, text):
    return {'id': message_id, 'internalDate': '1794499200000', 'payload': {
        'mimeType': 'text/plain', 'headers': [{'name': 'Subject', 'value': '알림 ' + message_id}],
        'body': {'data': base64.urlsafe_b64encode(text.encode()).decode()}}}


def proposal(source):
    return {'title': '준비 안내', 'summary': '준비할 일', 'questions': [], 'items': [
        {'title': '준비', 'kind': 'task', 'origin': 'source', 'evidence': source['text'][:5]}]}


async def test_triage_skips_passive_mail_and_previews_actionable_mail_with_durable_dedupe(store):
    triaged, analyzed = [], []
    bodies = {'fyi': '비공개 본문: 사진을 공유합니다.', 'action': '금요일까지 신청서를 준비해서 제출하세요.'}
    async def handler(request):
        assert request.headers['authorization'] == 'Bearer server-token'
        if request.url.path.endswith('/messages'):
            return httpx.Response(200, json={'messages': [{'id': key} for key in bodies]})
        message_id = request.url.path.rsplit('/', 1)[-1]
        return httpx.Response(200, json=mail(message_id, bodies[message_id]))
    async def triage(source):
        triaged.append(source['messageId'])
        return {'actionable': source['messageId'] == 'action', 'reason': bodies['fyi']}
    async def analyze(source):
        analyzed.append(source['messageId'])
        return proposal(source)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = Gmail(store, Plans(store), Tokens(), analyze, client, triage=triage)
        assert await service.collect('u') == {'imported': 1, 'skipped': 1, 'failed': 0, 'examined': 2}
        again = await service.collect('u')
    assert again == {'imported': 0, 'skipped': 0, 'failed': 0, 'examined': 0}
    assert triaged == ['fyi', 'action'] and analyzed == ['action']
    skipped = store.get('gmail-seen', 'u:fyi', 'u')
    assert skipped['status'] == 'skipped' and isinstance(skipped['reason'], str)
    assert bodies['fyi'] not in json.dumps(skipped, ensure_ascii=False)
    assert 'text' not in skipped and 'sourceId' not in skipped
    assert len(store.list('sources', 'u')) == len(store.list('drafts', 'u')) == 1
    assert store.list('items', 'u') == []


@pytest.mark.parametrize('bad_decision', [RuntimeError('private failure'), None,
    {'actionable': 'false', 'reason': '정보성'}, {'actionable': False},
    {'actionable': False, 'reason': ['bad']}, {'actionable': False, 'reason': 'x' * 241}])
async def test_failed_or_malformed_triage_does_not_mark_seen_and_retries_later(store, bad_decision):
    attempts = 0
    async def handler(request):
        if request.url.path.endswith('/messages'):
            return httpx.Response(200, json={'messages': [{'id': 'notice'}]})
        return httpx.Response(200, json=mail('notice', '금요일까지 서류를 준비하세요.'))
    async def triage(source):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            if isinstance(bad_decision, Exception):
                raise bad_decision
            return bad_decision
        return {'actionable': True, 'reason': '제출 요청'}
    async def analyze(source):
        return proposal(source)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = Gmail(store, Plans(store), Tokens(), analyze, client, triage=triage)
        assert await service.collect('u') == {'imported': 0, 'skipped': 0, 'failed': 1, 'examined': 1}
        assert store.get('gmail-seen', 'u:notice', 'u') is None
        assert store.list('sources', 'u') == []
        assert (await service.collect('u'))['imported'] == 1
    assert len(store.list('drafts', 'u')) == 1


async def test_ten_skipped_messages_stop_examination_before_next_page(store):
    list_calls, reads = [], []
    async def handler(request):
        if request.url.path.endswith('/messages'):
            list_calls.append(request)
            assert request.url.params['maxResults'] == '10'
            return httpx.Response(200, json={'messages': [{'id': str(i)} for i in range(10)], 'nextPageToken': 'more'})
        reads.append(request)
        return httpx.Response(200, json=mail(request.url.path.rsplit('/', 1)[-1], '참고용 소식입니다.'))
    async def triage(source):
        return {'actionable': False, 'reason': '참고용 소식'}
    async def analyze(source):
        pytest.fail('passive mail must not be analyzed')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await Gmail(store, Plans(store), Tokens(), analyze, client, triage=triage).collect('u')
    assert result == {'imported': 0, 'skipped': 10, 'failed': 0, 'examined': 10}
    assert len(list_calls) == 1 and len(reads) == 10
    assert store.get('gmail-settings', 'u', 'u')['nextPageToken'] == 'more'


async def test_seen_messages_do_not_consume_examination_budget_and_partial_page_resumes(store):
    store.put('gmail-seen', {'id': 'u:seen', 'ownerId': 'u'})
    rounds = 0
    async def handler(request):
        if request.url.path.endswith('/messages'):
            if request.url.params.get('pageToken') == 'second':
                return httpx.Response(200, json={'messages': [{'id': 'b' + str(i)} for i in range(10)]})
            return httpx.Response(200, json={'messages': [{'id': 'seen'}, {'id': 'a'}], 'nextPageToken': 'second'})
        return httpx.Response(200, json=mail(request.url.path.rsplit('/', 1)[-1], '참고용 소식입니다.'))
    async def triage(source):
        return {'actionable': False, 'reason': '참고용 소식'}
    async def analyze(source):
        pytest.fail('passive mail must not be analyzed')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = Gmail(store, Plans(store), Tokens(), analyze, client, triage=triage)
        first = await service.collect('u')
        assert first['examined'] == 10 and first['skipped'] == 10
        assert store.get('gmail-settings', 'u', 'u')['nextPageToken'] == 'second'
        second = await service.collect('u')
        assert second['examined'] == 1 and second['skipped'] == 1
    assert len(store.list('gmail-seen', 'u')) == 12


async def test_query_override_is_encoded_once_and_does_not_change_saved_query_or_cursor(store):
    saved = store.get('gmail-settings', 'u', 'u')
    store.put('gmail-settings', {**saved, 'nextPageToken': 'saved-query-cursor', 'enabled': False})
    override = "subject:\"팀 & 준비\" newer_than:30d -label:스팸 O'Brien"
    async def handler(request):
        assert request.url.params['q'] == override
        assert 'pageToken' not in request.url.params
        assert request.url.host == 'gmail.googleapis.com'
        return httpx.Response(200, json={'messages': []})
    async def analyze(source):
        pytest.fail('no messages')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await Gmail(store, Plans(store), Tokens(), analyze, client).collect('u', manual=True, query=override)
    assert result == {'imported': 0, 'skipped': 0, 'failed': 0, 'examined': 0}
    current = store.get('gmail-settings', 'u', 'u')
    assert current['query'] == '공지' and current['nextPageToken'] == 'saved-query-cursor'
    assert current['enabled'] is False


@pytest.mark.parametrize('query', ['', ' ', 'x' * 1001, {'q': 'in:inbox'}, 'bad\nquery'])
async def test_bad_query_override_rejected_before_requests(store, query):
    async def analyze(source):
        pytest.fail('no analysis')
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: pytest.fail('unexpected request'))) as client:
        with pytest.raises(AppError):
            await Gmail(store, Plans(store), Tokens(), analyze, client).collect('u', query=query)


async def test_account_deleted_and_reregistered_during_triage_is_never_resurrected(store):
    entered, release = asyncio.Event(), asyncio.Event()
    async def handler(request):
        if request.url.path.endswith('/messages'):
            return httpx.Response(200, json={'messages': [{'id': 'notice'}]})
        return httpx.Response(200, json=mail('notice', '참고용 소식입니다.'))
    async def triage(source):
        entered.set()
        await release.wait()
        return {'actionable': False, 'reason': '정보성'}
    async def analyze(source):
        pytest.fail('deleted account must not be analyzed')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = Gmail(store, Plans(store), Tokens(), analyze, client, triage=triage)
        collecting = asyncio.create_task(service.collect('u'))
        await asyncio.wait_for(entered.wait(), 2)
        store.delete('users', 'u', 'u')
        store.delete('gmail-settings', 'u', 'u')
        store.put('users', {'id': 'u', 'ownerId': 'u', 'generation': 'new'})
        release.set()
        result = await collecting
    assert result == {'imported': 0, 'skipped': 0, 'failed': 0, 'examined': 1}
    for collection in ('gmail-settings', 'gmail-seen', 'sources', 'drafts', 'items'):
        assert store.list(collection, 'u') == []
