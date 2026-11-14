import json
import httpx
import pytest
from chaenggim.domain import AppError
from chaenggim.vertex import Vertex


class Screen:
    def __init__(self, blocked=False): self.calls=[];self.blocked=blocked
    async def check_text(self,text):
        self.calls.append(('text',text))
        if self.blocked: raise AppError('차단된 입력',400)
    async def check_source(self,source):
        self.calls.append(('source',source))
        if self.blocked: raise AppError('차단된 자료',400)


async def token(): return 'unit-token'
def response(value,finish='STOP'):
    return httpx.Response(200,json={'candidates':[{'finishReason':finish,'content':{'parts':[{'text':json.dumps(value,ensure_ascii=False)}]}}]})


async def test_blocked_notice_does_not_reach_generation():
    requests=[]
    async def handler(request): requests.append(request);return response({})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        screen=Screen(True);vertex=Vertex(client,model='test-model',token_provider=token,armor=screen)
        with pytest.raises(AppError,match='차단된 자료'): await vertex.analyze({'kind':'text','text':'자료'})
        assert requests==[] and screen.calls[0][0]=='source'


async def test_latest_prompt_guard_is_exposed_to_intent_router():
    async with httpx.AsyncClient() as client:
        screen=Screen();vertex=Vertex(client,model='test-model',token_provider=token,armor=screen)
        await vertex.check_prompt('오늘 할 일 보여줘')
        assert screen.calls==[('text','오늘 할 일 보여줘')]


async def test_grounded_answer_screens_question_and_selected_sources():
    seen=[]
    async def handler(request):
        seen.append(json.loads(request.content));return response({'answer':'제출 기한은 오후 6시예요.','citations':['s1']})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        screen=Screen();vertex=Vertex(client,model='test-model',token_provider=token,armor=screen)
        sources=[{'id':'s1','title':'대회 안내','text':'오후 6시 제출','summary':'제출 안내','items':[]}]
        result=await vertex.answer('언제 제출해?',sources)
        assert result['citations']==['s1']
        assert screen.calls[0]==('text','언제 제출해?')
        assert any(kind=='source' and value['title']=='대회 안내' for kind,value in screen.calls)
        assert '오후 6시 제출' in seen[0]['contents'][0]['parts'][0]['text']
        assert 'responseSchema' in seen[0]['generationConfig']


@pytest.mark.parametrize('value,finish',[
    ({'answer':'다른 자료 참조','citations':['foreign']},'STOP'),
    ({'answer':'','citations':['s1']},'STOP'),
    ({'answer':'잘린 답변','citations':['s1']},'MAX_TOKENS'),
])
async def test_unowned_citations_or_incomplete_answers_are_rejected(value,finish):
    async def handler(request): return response(value,finish)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        vertex=Vertex(client,model='test-model',token_provider=token,armor=Screen())
        with pytest.raises(AppError): await vertex.answer('알려줘',[{'id':'s1','title':'내 자료','text':'내용'}])


@pytest.mark.parametrize('actionable',[True,False])
async def test_mail_triage_uses_screened_source_and_explicit_decision(actionable):
    async def handler(request):return response({'actionable':actionable,'reason':'준비할 내용 판단'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        screen=Screen();vertex=Vertex(client,model='test-model',token_provider=token,armor=screen)
        source={'kind':'gmail','title':'안내','text':'공지 본문','receivedAt':'2026-11-14T10:00:00+09:00'}
        result=await vertex.triage_mail(source)
        assert result['actionable'] is actionable
        assert screen.calls==[('source',source)]


async def test_malformed_triage_does_not_claim_mail_is_irrelevant():
    async def handler(request):return response({'actionable':'no','reason':'잘못된 형식'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        vertex=Vertex(client,model='test-model',token_provider=token,armor=Screen())
        with pytest.raises(AppError):await vertex.triage_mail({'kind':'gmail','text':'내용'})
