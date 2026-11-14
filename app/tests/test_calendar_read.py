import importlib
from datetime import datetime, timezone
from urllib.parse import quote

import httpx
import pytest

from chaenggim.domain import AppError
from chaenggim.store import Store


NOW = datetime(2026, 11, 13, 16, 20, tzinfo=timezone.utc)


class Tokens:
    def __init__(self):
        self.calls = []

    async def access_token(self, user, purpose):
        self.calls.append((user, purpose))
        return 'synthetic-calendar-token'


def service(store, client, tokens=None):
    try:
        module = importlib.import_module('chaenggim.google_calendar_read')
    except ModuleNotFoundError as error:
        if error.name != 'chaenggim.google_calendar_read':
            raise
        module = None
    assert module is not None, 'Read-only Google Calendar adapter is missing'
    return module.GoogleCalendarRead(store, tokens or Tokens(), client, clock=lambda: NOW)


def event(event_id='one', **changes):
    return {'id': event_id, 'summary': '외부 일정', 'status': 'confirmed',
            'start': {'dateTime': '2026-11-14T09:00:00+09:00'},
            'end': {'dateTime': '2026-11-14T10:00:00+09:00'}, **changes}


@pytest.fixture
def store():
    value = Store(':memory:')
    yield value
    value.close()


async def test_reads_primary_and_only_owned_ready_calendar_with_minimal_metadata(store):
    own_id = 'app+plan@group.calendar.google.com'
    own_record = {'id': 'u', 'ownerId': 'u', 'status': 'ready', 'calendarId': own_id}
    store.put('calendar', own_record)
    store.put('calendar', {'id': 'v', 'ownerId': 'v', 'status': 'ready', 'calendarId': 'other-private'})
    requests, tokens = [], Tokens()

    def handler(request):
        requests.append(request)
        assert request.method == 'GET' and request.url.host == 'www.googleapis.com'
        assert request.headers['authorization'] == 'Bearer synthetic-calendar-token'
        if request.url.path.endswith('/primary/events'):
            return httpx.Response(200, json={'items': [
                event('offset', start={'dateTime': '2026-11-14T02:00:00+01:00'},
                      end={'dateTime': '2026-11-14T03:00:00+01:00'},
                      htmlLink='https://www.google.com/calendar/event?eid=offset',
                      description='private description', attendees=[{'email': 'private@example.com'}]),
                event('day', summary='종일 일정', start={'date': '2026-11-14'}, end={'date': '2026-11-15'}),
                {'id': 'cancelled', 'status': 'cancelled'},
            ]})
        assert quote(own_id, safe='') in request.url.raw_path.decode()
        return httpx.Response(200, json={'items': [event('app', htmlLink='https://calendar.google.com/calendar/event?eid=app')]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await service(store, client, tokens).list_events('u', period='today')
    assert result['period'] == 'today' and result['truncated'] is False
    assert [item['id'] for item in result['items']] == ['day', 'app', 'offset']
    assert result['items'][0] == {'id': 'day', 'title': '종일 일정', 'start': '2026-11-14',
                                   'end': '2026-11-15', 'allDay': True, 'calendar': 'primary'}
    assert result['items'][1]['calendar'] == own_id
    assert result['items'][2]['start'] == '2026-11-14T10:00:00+09:00'
    assert 'htmlLink' in result['items'][1] and 'htmlLink' in result['items'][2]
    assert all('description' not in item and 'attendees' not in item for item in result['items'])
    assert tokens.calls == [('u', 'calendar_read')]
    assert len(requests) == 2
    assert store.get('calendar', 'u', 'u') == own_record
    assert store.list('items', 'u') == []


@pytest.mark.parametrize('period,start,end', [
    ('today', '2026-11-14T00:00:00+09:00', '2026-11-15T00:00:00+09:00'),
    ('tomorrow', '2026-11-15T00:00:00+09:00', '2026-11-16T00:00:00+09:00'),
    ('week', '2026-11-14T00:00:00+09:00', '2026-11-21T00:00:00+09:00'),
    ('month', '2026-11-14T00:00:00+09:00', '2026-12-14T00:00:00+09:00'),
])
async def test_period_bounds_are_server_kst_midnights(store, period, start, end):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'items': []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert (await service(store, client).list_events('u', period))['items'] == []
    params = requests[0].url.params
    assert params['timeMin'] == start and params['timeMax'] == end
    assert params['singleEvents'] == 'true' and params['orderBy'] == 'startTime'
    assert 1 <= int(params['maxResults']) <= 50


@pytest.mark.parametrize('status', ['creating', 'unknown', 'failed'])
async def test_unready_or_other_user_calendar_is_never_queried(store, status):
    store.put('calendar', {'id': 'u', 'ownerId': 'u', 'status': status, 'calendarId': 'unready'})
    store.put('calendar', {'id': 'v', 'ownerId': 'v', 'status': 'ready', 'calendarId': 'private'})
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'items': []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await service(store, client).list_events('u')
    assert len(requests) == 1 and requests[0].url.path.endswith('/primary/events')


async def test_query_and_page_tokens_are_literal_and_pagination_is_bounded(store):
    requests = []
    query = "발표 ' &q=other https://evil.example/path"
    cursor = 'cursor/?&literal=1'

    def handler(request):
        requests.append(request)
        assert request.url.host == 'www.googleapis.com' and request.url.params['q'] == query
        assert request.url.params['maxResults'] == '50'
        if len(requests) == 1:
            assert 'pageToken' not in request.url.params
            return httpx.Response(200, json={'items': [event('first')], 'nextPageToken': cursor})
        assert request.url.params['pageToken'] == cursor
        return httpx.Response(200, json={'items': [event('second')], 'nextPageToken': 'more'})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await service(store, client).list_events('u', query=query)
    assert len(requests) == 2 and result['truncated'] is True
    assert {item['id'] for item in result['items']} == {'first', 'second'}


async def test_global_cap_still_reads_owned_calendar_and_merges_by_actual_time(store):
    store.put('calendar', {'id': 'u', 'ownerId': 'u', 'status': 'ready', 'calendarId': 'owned'})
    requests = []

    def handler(request):
        requests.append(request)
        own = request.url.path.endswith('/owned/events')
        return httpx.Response(200, json={'items': [event(('own-' if own else 'primary-') + str(i),
            start={'dateTime': '2026-11-14T08:00:00+09:00' if own else '2026-11-14T09:00:00+09:00'})
            for i in range(50)]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await service(store, client).list_events('u')
    assert len(requests) == 2
    assert len(result['items']) == 50 and result['truncated'] is True
    assert all(item['calendar'] == 'owned' for item in result['items'])


@pytest.mark.parametrize('failure,status', [(401, 401), (403, 403), (500, 502), (429, 503), ('timeout', 502)])
async def test_errors_are_safe_and_never_return_false_empty_success(store, failure, status):
    def handler(request):
        if failure == 'timeout':
            raise httpx.ReadTimeout('private upstream request', request=request)
        return httpx.Response(failure, text='private upstream error body')

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AppError) as error:
            await service(store, client).list_events('u')
    assert error.value.status == status
    assert 'private' not in error.value.message
    if failure in (401, 403):
        assert '다시 연결' in error.value.message
    assert store.list('calendar', 'u') == []


@pytest.mark.parametrize('start,end', [
    ({'date': '2026-02-30'}, {'date': '2026-03-01'}),
    ({'dateTime': 'not-a-date'}, {'dateTime': '2026-11-14T10:00:00Z'}),
    ({'dateTime': '2026-11-14T09:00:00'}, {'dateTime': '2026-11-14T10:00:00'}),
    ({'dateTime': '2026-11-14T11:00:00+09:00'}, {'dateTime': '2026-11-14T10:00:00+09:00'}),
    ({'date': '2026-11-14'}, {'dateTime': '2026-11-14T10:00:00+09:00'}),
])
async def test_malformed_event_dates_raise_app_error(store, start, end):
    async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={'items': [event(start=start, end=end)]}))) as client:
        with pytest.raises(AppError):
            await service(store, client).list_events('u')


@pytest.mark.parametrize('link', ['https://evil.example/calendar/event', 'javascript:alert(1)',
                                'https://calendar.google.com@evil.example/calendar/event',
                                'https://calendar.google.com:444/calendar/event',
                                'https://www.google.com/redirect?url=https://evil.example'])
async def test_untrusted_event_links_are_omitted(store, link):
    async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={'items': [event(htmlLink=link)]}))) as client:
        result = await service(store, client).list_events('u')
    assert 'htmlLink' not in result['items'][0]


@pytest.mark.parametrize('period,query', [('https://evil.example', ''), ('week', 'x' * 201), ('today', 123)])
async def test_invalid_inputs_are_rejected_before_tokens_or_network(store, period, query):
    tokens = Tokens()
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: pytest.fail('unexpected request'))) as client:
        with pytest.raises(AppError):
            await service(store, client, tokens).list_events('u', period=period, query=query)
    assert tokens.calls == []
