import asyncio
import base64
import hmac
import json
import time
from contextlib import asynccontextmanager,suppress
from datetime import datetime,timedelta
from pathlib import Path
from urllib.parse import urlencode,urlparse
import httpx
from fastapi import FastAPI,Request,Depends
from fastapi.responses import JSONResponse,RedirectResponse,FileResponse,Response
from .auth import OAuth
from .calendar import Calendar
from .google_calendar_read import GoogleCalendarRead
from .domain import Plans,AppError,require
from .gmail import Gmail
from .intake import read_input
from .rules import RULES,check,KST
from .store import Store
from .vertex import Vertex
from .accounts import Accounts
from .google_products import GoogleTasks,GoogleDrive
from .calendar_export import export_calendar
from .chat import ChatAgent,IntentRouter

ROOT=Path(__file__).resolve().parent.parent
def public_source(source):return {**{k:v for k,v in source.items() if k not in ('data','text','_blob')},'hasFile':bool(source.get('data') or source.get('_blob'))}
async def read_json(request):
    chunks=[];size=0
    async for chunk in request.stream():
        size+=len(chunk)
        if size>6*1024*1024:raise AppError('자료가 너무 커요. 4MB 이하 파일을 넣어 주세요.',413)
        chunks.append(chunk)
    current_user_id(request)
    try:
        result=json.loads(b''.join(chunks) or b'{}')
        if not isinstance(result,dict):raise ValueError()
        return result
    except (ValueError,UnicodeDecodeError) as error:raise AppError('요청 내용을 읽을 수 없어요.') from error
def current_user_id(request):
    session=getattr(request.state,'session',None)
    user=session.get('user') if isinstance(session,dict) else None
    identity=user.get('id') if isinstance(user,dict) else None
    generation=user.get('generation') if isinstance(user,dict) else None
    if not isinstance(identity,str) or not identity or not isinstance(generation,str) or not generation:
        raise AppError('로그인이 필요해요.',401)
    current=request.app.state.store.get('users',identity,identity)
    if not current or current.get('id')!=identity or current.get('generation')!=generation:
        raise AppError('로그인이 변경됐어요. 다시 로그인해 주세요.',401)
    return identity

async def user_id(request:Request):
    return current_user_id(request)

def create_app(settings,store=None,analyze=None,client=None):
    if settings.demo and urlparse(settings.origin).hostname not in ('127.0.0.1','localhost'):raise ValueError('체험 모드는 로컬 주소에서만 실행할 수 있어요.')
    owns_store=store is None;store=store or Store(ROOT/'.data'/'app.sqlite')
    owns_client=client is None;client=client or httpx.AsyncClient(follow_redirects=False,trust_env=False)
    plans=Plans(store);oauth=OAuth(store,settings,client);calendar=Calendar(store,oauth,client)
    vertex=Vertex(client,project=settings.project,model=settings.model)
    mail_triage=vertex.triage_mail if analyze is None else None
    analyze=analyze or vertex.analyze
    gmail=Gmail(store,plans,oauth,analyze,client,triage=mail_triage);active=set();recent={}
    tasks=GoogleTasks(store,oauth,client);drive=GoogleDrive(store,oauth,client);accounts=Accounts(store,oauth,client)
    chat=ChatAgent(store,plans,analyze,IntentRouter(vertex),calendar,gmail,tasks,drive,accounts,oauth=oauth,calendar_reader=GoogleCalendarRead(store,oauth,client))
    async def collect_loop():
        while True:
            await asyncio.sleep(300)
            await gmail.tick()
    @asynccontextmanager
    async def lifespan(app):
        worker=asyncio.create_task(collect_loop())
        try:yield
        finally:
            worker.cancel()
            with suppress(asyncio.CancelledError):await worker
            if owns_client:await client.aclose()
            if owns_store:store.close()
    app=FastAPI(title='LERO',version='0.1.0',lifespan=lifespan)
    app.state.oauth=oauth;app.state.gmail=gmail;app.state.store=store
    @app.exception_handler(AppError)
    async def handle_error(request,error):return JSONResponse({'error':error.message},status_code=error.status)
    @app.middleware('http')
    async def security(request,call_next):
        request.state.session=oauth.session(request.cookies.get('cg_sid'))
        if request.method not in ('GET','HEAD','OPTIONS'):
            session=request.state.session;token=request.headers.get('X-CSRF-Token','')
            if request.headers.get('Origin')!=settings.origin:return JSONResponse({'error':'현재 서비스 화면에서 다시 시도해 주세요.'},status_code=403)
            if request.url.path!='/auth/demo' and (not session or not hmac.compare_digest(token,session['csrf'])):return JSONResponse({'error':'페이지를 새로고침하고 다시 시도해 주세요.'},status_code=403)
            length=request.headers.get('content-length','0')
            if not length.isdigit() or int(length)>6*1024*1024:return JSONResponse({'error':'자료 용량을 확인해 주세요.'},status_code=413)
        try:response=await call_next(request)
        except Exception:response=JSONResponse({'error':'처리 중 문제가 발생했어요. 다시 시도해 주세요.'},status_code=500)
        response.headers.update({'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
        return response
    def cookie(response,name,value,max_age=86400):response.set_cookie(name,value,max_age=max_age,httponly=True,samesite='lax',secure=settings.origin.startswith('https://'),path='/')
    @app.get('/health')
    async def health():return {'ok':True}
    @app.get('/api/me')
    async def me(request:Request):
        session=request.state.session
        return {'user':session['user'] if session else None,'csrf':session['csrf'] if session else None,'demo':settings.demo,'oauthConfigured':bool(settings.client_id and settings.client_secret)}
    @app.get('/auth/login')
    async def login():
        flow=oauth.begin();response=RedirectResponse(flow['url'],status_code=302);cookie(response,'cg_oauth',flow['flowId'],600);return response
    @app.get('/auth/connect/{purpose}')
    async def connect(purpose:str,user=Depends(user_id)):
        if purpose not in ('calendar','gmail','tasks','drive','calendar_read'):raise AppError('연결할 서비스를 확인해 주세요.',404)
        flow=oauth.begin(purpose,user);response=RedirectResponse(flow['url'],status_code=302);cookie(response,'cg_oauth',flow['flowId'],600);return response
    @app.get('/auth/callback')
    async def callback(request:Request):
        try:
            signed=await oauth.finish(request.query_params.get('state'),request.query_params.get('code'),request.cookies.get('cg_oauth'),request.state.session['user']['id'] if request.state.session else None)
            oauth.logout(request.cookies.get('cg_sid'));response=RedirectResponse('/' if signed['purpose']=='login' else '/#settings',status_code=302);cookie(response,'cg_sid',signed['sid'])
        except Exception as error:response=RedirectResponse('/?'+urlencode({'authError':error.message if isinstance(error,AppError) else '로그인을 완료하지 못했어요. 다시 시도해 주세요.'}),status_code=302)
        cookie(response,'cg_oauth','',0);return response
    @app.post('/auth/demo')
    async def demo(request:Request):
        if not settings.demo:raise AppError('체험 모드는 실행 중이지 않아요.',404)
        user=store.put('users',{'id':'local-demo','ownerId':'local-demo','name':'체험 사용자','email':'로컬 체험 계정'})
        oauth.logout(request.cookies.get('cg_sid'));signed=oauth.create_session(user);response=JSONResponse({'ok':True});cookie(response,'cg_sid',signed['sid']);return response
    @app.post('/auth/logout')
    async def logout(request:Request,user=Depends(user_id)):
        oauth.logout(request.cookies.get('cg_sid'));response=JSONResponse({'ok':True});cookie(response,'cg_sid','',0);return response
    @app.post('/api/account/delete')
    async def delete_account(user=Depends(user_id)):
        result=await accounts.delete(user);response=JSONResponse(result);cookie(response,'cg_sid','',0);return response
    @app.get('/api/chat/threads')
    async def chat_threads(user=Depends(user_id)):return chat.list_threads(user)
    @app.post('/api/chat/threads')
    async def create_chat_thread(request:Request,user=Depends(user_id)):
        data=await read_json(request)
        current_user_id(request)
        return chat.create_thread(user,data.get('title'))
    @app.delete('/api/chat/threads/{conversation_id}')
    async def delete_chat_thread(conversation_id:str,user=Depends(user_id)):
        return chat.delete_thread(user,conversation_id)
    @app.get('/api/chat')
    async def get_chat(conversationId:str|None=None,user=Depends(user_id)):
        return chat.for_thread(user,conversationId).state(user)
    @app.post('/api/chat')
    async def send_chat(request:Request,user=Depends(user_id)):
        data=await read_json(request)
        current_user_id(request)
        result=await chat.for_thread(user,data.get('conversationId')).send(user,data);response=JSONResponse(result)
        if result.get('loggedOut'):oauth.logout(request.cookies.get('cg_sid'));cookie(response,'cg_sid','',0)
        return response
    @app.get('/api/state')
    async def state(user=Depends(user_id)):
        return {'sources':[public_source(s) for s in store.list('sources',user)],'drafts':store.list('drafts',user),'items':store.list('items',user),'connected':oauth.connected(user),'gmail':gmail.settings(user),'calendar':store.get('calendar',user,user)}
    @app.get('/api/rules')
    async def rules(user=Depends(user_id)):return [{'id':id,'text':text} for id,text in RULES.items()]
    @app.post('/api/check')
    async def check_input(request:Request,user=Depends(user_id)):return check({**await read_json(request),'userId':user,'ownerId':user})
    @app.get('/api/sources/{id}')
    async def source(id:str,user=Depends(user_id)):
        doc=require(store.get('sources',id,user));return {**{k:v for k,v in doc.items() if k not in ('data','_blob')},'hasFile':bool(doc.get('data') or doc.get('_blob'))}
    @app.get('/api/sources/{id}/file')
    async def source_file(id:str,user=Depends(user_id)):
        doc=require(store.get('sources',id,user))
        if not doc.get('data') and not doc.get('_blob'):raise AppError('첨부 파일이 없어요.',404)
        data=store.read_file(doc) if hasattr(store,'read_file') else base64.b64decode(doc['data'])
        return Response(data,media_type=doc['mime'],headers={'Content-Disposition':'inline'})
    async def input_source(request,user,id=None):
        if user in active:raise AppError('앞선 자료를 분석 중이에요. 잠시 기다려 주세요.',429)
        times=[n for n in recent.get(user,[]) if n>time.time()-60]
        if len(times)>=5:raise AppError('자료는 1분에 5개까지 분석할 수 있어요. 잠시 후 다시 시도해 주세요.',429)
        recent[user]=times+[time.time()];active.add(user)
        try:
            original=require(store.get('sources',id,user)) if id else None
            data=await read_input(await read_json(request))
            existing=[i for i in store.list('items',user) if i['sourceId']==id] if original else []
            analysis_data={**data,'existingItems':[{k:i.get(k) for k in ('id','title','kind','start','end')} for i in existing]}
            proposal=await analyze(analysis_data)
            with store.transaction():
                current_user=require(store.get('users',user,user))
                if current_user.get('generation')!=request.state.session['user'].get('generation'):raise AppError('로그인이 변경됐어요. 다시 시작해 주세요.',401)
                if original:
                    latest=require(store.get('sources',id,user))
                    if latest['version']!=original['version']:raise AppError('다른 수정 공지가 먼저 반영됐어요. 최신 자료에서 다시 추가해 주세요.',409)
                    source=store.put('sources',{**{k:latest[k] for k in ('id','ownerId','createdAt')},**data,'version':latest['version']+1})
                else:source=plans.add_source(user,data)
                if original:
                    for item in proposal['items']:
                        matches=[i for i in existing if i['kind']==item['kind'] and (i['id']==item.get('replacesId') or i['title']==item['title'])]
                        item['replacesId']=matches[0]['id'] if len(matches)==1 else None
                draft=plans.propose(user,source['id'],proposal)
            return JSONResponse({'source':public_source(source),'draft':draft},status_code=201)
        finally:active.discard(user)
    @app.post('/api/sources')
    async def add_source(request:Request,user=Depends(user_id)):return await input_source(request,user)
    @app.post('/api/sources/{id}/revise')
    async def revise(id:str,request:Request,user=Depends(user_id)):return await input_source(request,user,id)
    @app.patch('/api/drafts/{id}')
    async def edit_draft(id:str,request:Request,user=Depends(user_id)):
        data=await read_json(request);return plans.edit(user,id,data.get('version'),data.get('items'))
    @app.post('/api/drafts/{id}/approve')
    async def approve(id:str,request:Request,user=Depends(user_id)):return plans.approve(user,id,(await read_json(request)).get('version'))
    @app.patch('/api/items/{id}')
    async def complete(id:str,request:Request,user=Depends(user_id)):return plans.complete(user,id,(await read_json(request)).get('done'))
    @app.post('/api/tasks/sync')
    async def sync_task(request:Request,user=Depends(user_id)):return await tasks.sync(user,(await read_json(request)).get('itemId'))
    @app.get('/api/drive/files')
    async def drive_files(q:str='',pageToken:str|None=None,user=Depends(user_id)):return await drive.list_files(user,q,pageToken)
    @app.post('/api/drive/import')
    async def import_drive(request:Request,user=Depends(user_id)):
        source_input=await drive.import_file(user,(await read_json(request)).get('fileId'))
        proposal=await analyze(source_input)
        with store.transaction():
            profile=require(store.get('users',user,user))
            if profile.get('generation')!=request.state.session['user'].get('generation'):raise AppError('로그인이 변경됐어요. 다시 시작해 주세요.',401)
            source=plans.add_source(user,source_input);draft=plans.propose(user,source['id'],proposal)
        return JSONResponse({'source':public_source(source),'draft':draft},status_code=201)
    @app.get('/api/calendar/export')
    async def calendar_export(user=Depends(user_id)):return Response(export_calendar(store.list('items',user)),media_type='text/calendar; charset=utf-8',headers={'Content-Disposition':'attachment; filename="lero.ics"'})
    @app.post('/api/calendar/sync')
    async def sync(request:Request,user=Depends(user_id)):
        if not oauth.connected(user)['calendar']:raise AppError('설정에서 Google Calendar를 먼저 연결해 주세요.',409)
        return await calendar.sync(user,(await read_json(request)).get('itemId'))
    @app.post('/api/calendar/recover')
    async def recover_calendar(request:Request,user=Depends(user_id)):return await calendar.recover(user,(await read_json(request)).get('calendarId'))
    @app.post('/api/gmail/settings')
    async def gmail_settings(request:Request,user=Depends(user_id)):
        if not oauth.connected(user)['gmail']:raise AppError('Gmail을 먼저 연결해 주세요.',409)
        return gmail.settings(user,await read_json(request))
    @app.post('/api/gmail/collect')
    async def collect(user=Depends(user_id)):return await gmail.collect(user,manual=True)
    @app.post('/api/disconnect/{purpose}')
    async def disconnect(purpose:str,user=Depends(user_id)):
        if purpose not in ('calendar','gmail','tasks','drive','calendar_read'):raise AppError('연결할 서비스를 확인해 주세요.',404)
        oauth.disconnect(user,purpose);return {'ok':True}
    @app.post('/api/demo-seed')
    async def seed(user=Depends(user_id)):
        if not settings.demo or user!='local-demo':raise AppError('예시 자료를 추가할 수 없어요.',404)
        if store.list('sources',user):return {'ok':True}
        day=(datetime.now(KST)+timedelta(days=1)).date().isoformat()
        text=f'주말 소풍 안내\n{day} 오전 10시부터 12시까지 한강공원에서 만나요.\n준비물은 물과 돗자리예요.'
        source=plans.add_source(user,{'kind':'text','title':'주말 소풍 안내','text':text})
        draft=plans.propose(user,source['id'],{'title':'주말 소풍','summary':'내일 한강공원에서 만나요. 물과 돗자리를 준비해 주세요.','questions':[],'items':[{'title':'주말 소풍','kind':'event','start':day+'T10:00:00+09:00','end':day+'T12:00:00+09:00','origin':'source','evidence':'한강공원에서 만나요.'},{'title':'물과 돗자리 준비','kind':'task','start':day+'T08:00:00+09:00','origin':'suggested','evidence':'준비물은 물과 돗자리예요.'}]})
        return {'ok':True,'draftId':draft['id']}
    @app.get('/')
    async def index():return FileResponse(ROOT/'web'/'index.html')
    @app.get('/kiro-icon.png')
    async def kiro_icon():return FileResponse(ROOT/'web'/'kiro-icon.png',media_type='image/png')
    @app.get('/styles.css')
    async def css():return FileResponse(ROOT/'web'/'styles.css',media_type='text/css')
    @app.get('/app.js')
    async def javascript():return FileResponse(ROOT/'web'/'app.js',media_type='text/javascript')
    @app.get('/chat.js')
    async def chat_javascript():return FileResponse(ROOT/'web'/'chat.js',media_type='text/javascript')
    @app.get('/chat.css')
    async def chat_css():return FileResponse(ROOT/'web'/'chat.css',media_type='text/css')
    @app.get('/landing.css')
    async def landing_css():return FileResponse(ROOT/'web'/'landing.css',media_type='text/css')
    @app.get('/policy.css')
    async def policy_css():return FileResponse(ROOT/'web'/'policy.css',media_type='text/css')
    @app.get('/privacy')
    async def privacy():return FileResponse(ROOT/'web'/'privacy.html')
    @app.get('/terms')
    async def terms():return FileResponse(ROOT/'web'/'terms.html')
    return app
