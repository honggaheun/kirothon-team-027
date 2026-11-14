import pytest

from chaenggim.chat import ChatAgent, INTENT_SCHEMA, _bounded_context
from chaenggim.domain import Plans
from chaenggim.store import Store


class Router:
    async def route(self, text, context):
        return {'tool': 'list'}


class Connections:
    def __init__(self, **flags):
        self.flags = flags

    def connected(self, user):
        return self.flags


class Reader:
    def __init__(self, result, store=None):
        self.result, self.calls, self.store = result, [], store

    async def list_events(self, user, period='week', query=''):
        self.calls.append((user, period, query))
        if self.store:
            self.store.put('users', {'id': 'u', 'ownerId': 'u', 'generation': 'changed'})
        return self.result

    async def list_items(self, user, query=''):
        self.calls.append((user, query))
        return self.result


@pytest.fixture
def store():
    value = Store(':memory:')
    value.put('users', {'id': 'u', 'ownerId': 'u', 'generation': 'g'})
    yield value
    value.close()


def agent(store, reader, **flags):
    return ChatAgent(store, Plans(store), None, Router(), None, None, reader, None, None,
                     oauth=Connections(**flags), calendar_reader=reader)


async def test_google_calendar_reads_real_content_when_internal_items_empty(store):
    reader = Reader({'items': [{'id': 'e', 'title': '고객 회의', 'start': '2026-11-14T01:00:00Z',
                                'end': '2026-11-14T02:00:00Z', 'calendar': '업무'}], 'truncated': False})
    result = await agent(store, reader, calendar_read=True).send('u', {'text': 'google 캘린더 내용 확인해봐'})
    text = result['messages'][-1]['text']
    assert 'Google Calendar 조회 결과' in text
    assert '고객 회의' in text and '10:00 KST' in text
    assert '아직 등록한' not in text
    assert reader.calls == [('u', 'week', '')]
    assert store.list('items', 'u') == []
    assert store.list('drafts', 'u') == []


async def test_calendar_read_uses_readonly_connection_even_with_write_connection(store):
    reader = Reader({'items': []})
    result = await agent(store, reader, calendar=True).send('u', {'text': '구글 캘린더 오늘 일정 보여줘'})
    assert result['messages'][-1]['actions'][0]['href'] == '/auth/connect/calendar_read'
    assert reader.calls == []


@pytest.mark.parametrize(('text', 'period'), [('구글 캘린더 오늘 일정', 'today'),
    ('Google Calendar 내일 일정 알려줘', 'tomorrow'), ('구글 캘린더 이번 달 일정 조회', 'month')])
async def test_calendar_period_override(store, text, period):
    reader = Reader({'items': []})
    result = await agent(store, reader, calendar_read=True).send('u', {'text': text})
    assert reader.calls == [('u', period, '')]
    assert 'Google 일정이 없어요' in result['messages'][-1]['text']


async def test_google_tasks_real_list_with_status_due_and_list_title(store):
    reader = Reader({'items': [{'id': 't', 'title': '보고서 보내기', 'due': '2026-11-15T00:00:00Z',
                                'status': 'needsAction', 'listTitle': '업무'}], 'truncated': True})
    result = await agent(store, reader, tasks=True).send('u', {'text': 'Google Tasks 할 일 확인해줘'})
    text = result['messages'][-1]['text']
    assert 'Google Tasks 조회 결과' in text and '보고서 보내기' in text
    assert '미완료' in text and '마감' in text and '업무' in text and '일부만' in text
    assert reader.calls == [('u', '')]


async def test_internal_list_remains_internal(store):
    reader = Reader({'items': []})
    result = await agent(store, reader, calendar_read=True, tasks=True).send('u', {'text': '내 할 일 보여줘'})
    assert '아직 등록한 일정과 할 일' in result['messages'][-1]['text']
    assert reader.calls == []


async def test_read_generation_change_never_saves_response(store):
    reader = Reader({'items': []}, store=store)
    with pytest.raises(Exception, match='계정 상태가 변경'):
        await agent(store, reader, calendar_read=True).send('u', {'text': '구글 캘린더 확인해줘'})
    assert store.get('chat', 'u', 'u') is None


def test_schema_contains_read_intents_periods_and_read_connection():
    properties = INTENT_SCHEMA['properties']
    assert {'calendar_list', 'tasks_list'} <= set(properties['tool']['enum'])
    assert properties['period']['enum'] == ['today', 'tomorrow', 'week', 'month']
    assert 'calendar_read' in properties['service']['enum']
    assert _bounded_context({'connected': {'calendar_read': True}})['connected']['calendar_read'] is True

async def test_llm_read_query_is_passed_and_internal_list_cannot_mask_it(store):
    class QueryRouter:
        async def route(self, text, context):
            return {'tool': 'calendar_list', 'period': 'today', 'query': '고객'}
    reader = Reader({'items': [{'id': 'e', 'title': '고객 면담', 'start': '2026-11-14', 'allDay': True}]})
    service = agent(store, reader, calendar_read=True)
    service.router = QueryRouter()
    result = await service.send('u', {'text': '연결한 일정에서 고객 미팅 찾아줘'})
    assert reader.calls == [('u', 'today', '고객')]
    assert '고객 면담' in result['messages'][-1]['text']
    assert '종일' in result['messages'][-1]['text']


async def test_google_tasks_disconnected_prompts_correct_service(store):
    reader = Reader({'items': []})
    result = await agent(store, reader).send('u', {'text': '구글 할 일 내용 확인해줘'})
    assert result['messages'][-1]['actions'][0]['href'] == '/auth/connect/tasks'
    assert reader.calls == []


def test_server_read_override_does_not_turn_explicit_writes_into_reads():
    for text in ('구글 캘린더에 준비 일정을 등록해줘', 'Google Tasks 할 일 추가해줘'):
        assert ChatAgent._read_intent(text) is None

async def test_google_tasks_due_is_date_only_without_fictitious_time(store):
    reader = Reader({'items': [{'title': '보고서', 'due': '2026-11-15T00:00:00Z', 'status': 'needsAction'}]})
    result = await agent(store, reader, tasks=True).send('u', {'text': 'Google Tasks 확인해줘'})
    text = result['messages'][-1]['text']
    assert '2026년 11월 15일' in text
    assert '09:00' not in text and 'KST' not in text


@pytest.mark.parametrize(('calendar', 'label'), [('primary', '기본 캘린더'), ('private@example.com', 'LERO 캘린더')])
async def test_calendar_identifier_is_replaced_by_product_label(store, calendar, label):
    reader = Reader({'items': [{'title': '회의', 'start': '2026-11-14', 'calendar': calendar}]})
    result = await agent(store, reader, calendar_read=True).send('u', {'text': '구글 캘린더 내용 확인'})
    text = result['messages'][-1]['text']
    assert label in text
    assert calendar not in text


@pytest.mark.parametrize(('phrase', 'period'), [('앞으로 30일', 'month'), ('30일', 'month'), ('앞으로 7일', 'week')])
async def test_quoted_query_and_rolling_period_are_passed(store, phrase, period):
    reader = Reader({'items': []})
    await agent(store, reader, calendar_read=True).send('u', {'text': f'Google 캘린더에서 "LERO 테스트" {phrase} 일정 보여줘'})
    assert reader.calls == [('u', period, 'LERO 테스트')]


@pytest.mark.parametrize('negative', ['찾지 마', '검색하지 마', '요약하지 마', '알려주지 마'])
async def test_negative_read_requests_never_call_external_adapter(store, negative):
    reader = Reader({'items': []})
    await agent(store, reader, calendar_read=True).send('u', {'text': 'Google 캘린더 일정 ' + negative})
    assert reader.calls == []

async def test_repeated_large_korean_google_results_fit_firestore_document(store):
    import json
    from chaenggim.cloud_store import FirestoreStore
    reader = Reader({'items': [{'title': '가' * 1024, 'listTitle': '나' * 1024,
                                'status': 'needsAction'} for _ in range(50)]})
    service = agent(store, reader, tasks=True)
    validator = FirestoreStore.__new__(FirestoreStore)
    validator.project = 'test'
    for _ in range(5):
        result = await service.send('u', {'text': 'Google Tasks 내용 확인해줘'})
        answer = result['messages'][-1]['text']
        assert len(answer.encode('utf-8')) <= 16000
        assert '일부만' in answer
        document = store.get('chat', 'u', 'u')
        assert len(json.dumps(document, ensure_ascii=False).encode('utf-8')) <= 600 * 1024
        validator.prepare('chat', document)


async def test_history_byte_budget_preserves_latest_large_user_and_file_metadata(store):
    import json
    from chaenggim.cloud_store import FirestoreStore
    service = agent(store, Reader({'items': []}))
    store.put('chat', {'id': 'u', 'ownerId': 'u', 'messages': [
        {'role': 'user' if index % 2 == 0 else 'assistant', 'text': '이전' * 15000}
        for index in range(22)]})
    user_message = service._message('user', '가' * 10000)
    answer = service._message('assistant', '최신 결과', files=[{'id': 'f', 'name': '나' * 10000}])
    result = service._save('u', 'g', user_message, answer)
    assert result['messages'][-2:] == [user_message, answer]
    document = store.get('chat', 'u', 'u')
    assert len(json.dumps(document, ensure_ascii=False).encode('utf-8')) <= 600 * 1024
    assert len(document['messages']) < 24
    validator = FirestoreStore.__new__(FirestoreStore)
    validator.project = 'test'
    validator.prepare('chat', document)

async def test_exact_demo_today_calendar_question_bypasses_router_and_shows_kst_times(store):
    class NeverRoute:
        async def route(self, text, context):
            raise AssertionError('Explicit Google Calendar read must bypass LLM')
    reader = Reader({'items': [{'title': '팀 회의', 'start': '2026-11-14T01:00:00Z',
                                'end': '2026-11-14T02:30:00Z', 'calendar': 'primary'}]})
    service = agent(store, reader, calendar_read=True)
    service.router = NeverRoute()
    result = await service.send('u', {'text': '구글 캘린더에 오늘 일정 있어?'})
    text = result['messages'][-1]['text']
    assert reader.calls == [('u', 'today', '')]
    assert '팀 회의' in text and '10:00–11:30' in text
    assert '일정은 1개' in text
    assert '2026년' not in text
