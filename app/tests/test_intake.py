import base64
import importlib
import pytest
import httpx
from chaenggim.store import Store
from chaenggim.domain import Plans,AppError,validate_proposal

def module(name):
    try:return importlib.import_module('chaenggim.'+name)
    except ModuleNotFoundError:return None

@pytest.mark.parametrize('url',['http://127.0.0.1','http://localhost','http://169.254.169.254','http://[::1]','http://[::ffff:7f00:1]','file:///etc/passwd','https://u:p@example.com'])
async def test_private_url_blocked(url):
    intake=module('intake');assert intake
    with pytest.raises(AppError):await intake.validate_public_url(url)

async def test_dns_mixed_answer_and_safe_public_ip():
    intake=module('intake');assert intake
    async def mixed(host):return ['93.184.216.34','10.0.0.1']
    async def public(host):return ['93.184.216.34']
    with pytest.raises(AppError):await intake.validate_public_url('https://example.com',mixed)
    assert (await intake.validate_public_url('https://example.com',public))[1]=='93.184.216.34'

async def test_intake_files_text_html_and_evidence():
    intake=module('intake');assert intake
    with pytest.raises(AppError):await intake.read_input({'kind':'file','name':'x.pdf','mime':'application/pdf','data':base64.b64encode(b'hello').decode()})
    with pytest.raises(AppError):await intake.read_input({'kind':'text','text':' '})
    assert (await intake.read_input({'kind':'text','text':'물 준비'}))['text']=='물 준비'
    assert 'steal' not in intake.html_text('<script>steal()</script><h1>공지</h1>물 준비')
    with pytest.raises(AppError):validate_proposal({'title':'x','summary':'','questions':[],'items':[{'title':'x','kind':'task','evidence':'없는 근거'}]},{'text':'원문'})

def test_notion_public_blocks_preserve_document_order_and_rich_text():
    intake=module('intake');assert intake
    assert hasattr(intake,'notion_blocks_text')
    blocks={'root':{'value':{'value':{'type':'page','properties':{'title':[['대회 안내']]},'content':['a','b']}}},'b':{'value':{'value':{'type':'text','properties':{'title':[['18:00'],[' 전에 제출']]}}}},'a':{'value':{'value':{'type':'text','properties':{'title':[['준비물: '],['노트북',[['b']]]]}}}}}
    assert intake.notion_blocks_text(blocks,'root')=='대회 안내\n준비물: 노트북\n18:00 전에 제출'

async def test_model_invalid_output_rejected():
    vertex=module('vertex');assert vertex
    async def token():return 'token'
    async def handler(req):return httpx.Response(200,json={'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':'{"invalid":true}'}]}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service=vertex.Vertex(client,model='test-model',token_provider=token)
        with pytest.raises(AppError):await service.analyze({'kind':'text','title':'공지','text':'소풍'})

async def test_gmail_deduplicates_and_creates_only_drafts():
    gmail=module('gmail');assert gmail
    store=Store(':memory:');plans=Plans(store);reads=0
    async def handler(req):
        nonlocal reads
        if req.url.query:
            assert req.url.params['q']=='newer_than:14d 소풍'
            return httpx.Response(200,json={'messages':[{'id':'m1','threadId':'t1'}]})
        reads+=1
        return httpx.Response(200,json={'id':'m1','threadId':'t1','snippet':'소풍 안내','payload':{'mimeType':'text/plain','headers':[{'name':'Subject','value':'소풍 안내'},{'name':'From','value':'organizer@example.com'}],'body':{'data':base64.urlsafe_b64encode('소풍. 물 준비'.encode()).decode()}}})
    async def analyze(source):return {'title':'소풍','summary':'안내','questions':[],'items':[{'title':'물 준비','kind':'task','origin':'source','evidence':'물 준비'}]}
    class Tokens:
        async def access_token(self,*args):return 'token'
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service=gmail.Gmail(store,plans,Tokens(),analyze,client)
        service.settings('u',{'enabled':True,'query':'newer_than:14d 소풍'})
        assert (await service.collect('u'))['imported']==1
        assert (await service.collect('u'))['imported']==0
        assert reads==1;assert len(store.list('drafts','u'))==1;assert store.list('items','u')==[]
        service.settings('u',{'enabled':False,'query':'newer_than:14d 소풍'})
        assert (await service.collect('u'))['disabled'] is True
    store.close()
