import asyncio
import pytest
from chaenggim.domain import AppError
from test_chat import agent, Router, store, proposal


class AnswerRouter(Router):
    def __init__(self, result=None):
        super().__init__({'tool': 'analyze'})
        self.answer_calls = []
        self.result = result

    async def answer(self, question, sources):
        self.answer_calls.append((question, sources))
        return self.result or {'answer': '제공한 안내에 따르면 신청 마감은 11월 20일이에요.',
                               'citations': [sources[0]['id']]}


def source(store, id='notice', owner='u', title='kirothon 참가 안내', text='신청 마감은 11월 20일입니다.'):
    return store.put('sources', {'id': id, 'ownerId': owner, 'title': title, 'text': text})


async def test_existing_notice_question_answers_content_instead_of_analyzing_question(store):
    source(store)
    router = AnswerRouter()
    service = agent(store, router)
    result = await service.send('u', {'text': 'kirothon 안내해줘'})
    answer = result['messages'][-1]
    assert '11월 20일' in answer['text']
    assert answer['sources'] == [{'id': 'notice', 'title': 'kirothon 참가 안내'}]
    assert router.answer_calls[0][1][0]['text'] == '신청 마감은 11월 20일입니다.'
    assert store.list('drafts', 'u') == []
    assert len(store.list('sources', 'u')) == 1
    assert router.contexts == []


async def test_question_without_owned_data_requests_source_without_analyzing(store):
    router = AnswerRouter()
    service = agent(store, router)
    source(store, owner='v')
    result = await service.send('u', {'text': 'kirothon 안내해줘'})
    assert '자료가 아직 없어요' in result['messages'][-1]['text']
    assert router.answer_calls == [] and router.contexts == []
    assert store.list('sources', 'u') == []


async def test_ambiguous_notices_ask_for_source_and_exact_title_resolves(store):
    source(store)
    source(store, id='trip', title='주말 소풍 안내')
    router = AnswerRouter()
    service = agent(store, router)
    ambiguous = await service.send('u', {'text': '마감이 언제야?'})
    assert '어떤 자료' in ambiguous['messages'][-1]['text']
    assert router.answer_calls == []
    await service.send('u', {'text': 'kirothon 언제야?'})
    assert router.answer_calls[0][1][0]['id'] == 'notice'


async def test_forged_source_id_and_citations_fail_closed(store):
    source(store)
    source(store, id='secret', owner='v')
    router = AnswerRouter({'answer': '외부 답변', 'citations': ['secret']})
    service = agent(store, router)
    result = await service.send('u', {'text': 'kirothon 안내해줘'})
    assert '외부 답변' not in result['messages'][-1]['text']
    assert '확인하지 못' in result['messages'][-1]['text']
    context = service._context('u', '질문')
    with pytest.raises(AppError):
        await service._answer('u', 'g', '질문', {'sourceId': 'secret'}, context)


async def test_pdf_without_text_uses_explicitly_labeled_draft_extract_not_binary(store):
    source(store, text='')
    store.put('drafts', {'id': 'd', 'ownerId': 'u', 'sourceId': 'notice', 'summary': '신청 안내',
                         'items': [{'title': '신청', 'evidence': '마감 11월 20일'}]})
    router = AnswerRouter()
    result = await agent(store, router).send('u', {'text': 'kirothon 안내해줘'})
    grounding = router.answer_calls[0][1][0]
    assert '원본 파일 본문이 아닌' in grounding['text']
    assert grounding['summary'] == '신청 안내'
    assert grounding['items'][0]['evidence'] == '마감 11월 20일'
    assert result['messages'][-1]['sources'][0]['id'] == 'notice'


async def test_grounding_text_is_bounded_and_account_generation_guarded_after_answer(store):
    source(store, text='가' * 50000)
    class ChangingRouter(AnswerRouter):
        async def answer(self, question, sources):
            assert len(sources[0]['text']) == 30000
            store.put('users', {'id': 'u', 'ownerId': 'u', 'generation': 'changed'})
            return {'answer': '저장되면 안 되는 답변', 'citations': ['notice']}
    with pytest.raises(AppError):
        await agent(store, ChangingRouter()).send('u', {'text': 'kirothon 안내해줘'})
    assert store.get('chat', 'u', 'u') is None


async def test_new_notice_still_analyzes_and_exposes_owned_source_metadata_to_router(store):
    source(store, owner='v')
    router = AnswerRouter()
    result = await agent(store, router).send('u', {'text': '대회 공지 11월 20일 신청 마감'})
    assert result['pendingDraftId']
    assert router.answer_calls == []
    assert router.contexts[0]['sources'] == []
