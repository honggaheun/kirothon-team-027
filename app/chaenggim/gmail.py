import base64
from datetime import datetime,timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote
from .domain import AppError,now
from .intake import html_text

DEFAULT_QUERY='newer_than:14d (공지 OR 안내 OR 마감 OR 준비물 OR 신청) -in:spam -in:trash'
def mail_text(payload):
    chunks=[]
    def visit(part):
        if part.get('body',{}).get('data') and part.get('mimeType') in ('text/plain','text/html'):
            data=part['body']['data'];raw=base64.urlsafe_b64decode(data+'='*(-len(data)%4)).decode('utf-8',errors='replace')
            chunks.append((part['mimeType'],html_text(raw) if part['mimeType']=='text/html' else raw))
        for nested in part.get('parts',[]):visit(nested)
    visit(payload)
    plain=[text for kind,text in chunks if kind=='text/plain']
    return '\n'.join(plain or [text for _,text in chunks])[:50000]

class Gmail:
    def __init__(self,store,plans,oauth,analyze,client,*,triage=None):self.store=store;self.plans=plans;self.oauth=oauth;self.analyze=analyze;self.client=client;self.triage=triage;self.active=set()
    def settings(self,user,input=None):
        previous=self.store.get('gmail-settings',user,user) or {'id':user,'ownerId':user,'enabled':False,'query':DEFAULT_QUERY}
        if input is None:return previous
        if not isinstance(input.get('enabled'),bool) or not isinstance(input.get('query'),str) or not input['query'].strip() or len(input['query'])>1000:raise AppError('Gmail 검색 조건을 확인해 주세요.')
        return self.store.put('gmail-settings',{**previous,'enabled':input['enabled'],'query':input['query'].strip(),'nextPageToken':previous.get('nextPageToken') if previous['query']==input['query'].strip() else None,'lastError':None})
    async def request(self,token,path,params=None):
        response=await self.client.get('https://gmail.googleapis.com/gmail/v1/users/me'+path,headers={'Authorization':'Bearer '+token},params=params,timeout=15)
        if response.status_code!=200:raise AppError('Gmail을 가져오지 못했어요. 설정에서 연결을 확인해 주세요.',502)
        return response.json()
    async def collect(self,user,manual=False,query=None):
        if query is not None and (not isinstance(query,str) or not query.strip() or len(query)>1000 or any(ord(c)<32 for c in query)):
            raise AppError('Gmail 검색 조건을 1000자 이내로 입력해 주세요.')
        settings=self.settings(user)
        profile=self.store.get('users',user,user)
        generation=profile.get('generation') if profile else None
        def current_account():
            current=self.store.get('users',user,user)
            return profile is None or bool(current and current.get('generation')==generation)
        def permitted():return current_account() and (manual or self.settings(user)['enabled'])
        counts={'imported':0,'skipped':0,'failed':0,'examined':0}
        if not settings['enabled'] and not manual:return {'disabled':True,**counts}
        if user in self.active:return {'busy':True,**counts}
        self.active.add(user);attempted=set()
        try:
            token=await self.oauth.access_token(user,'gmail')
            cursor=settings.get('nextPageToken') if query is None else None
            for _ in range(5):
                if not permitted():break
                page_start=cursor
                params={'q':settings['query'] if query is None else query.strip(),'maxResults':10}
                if cursor:params['pageToken']=cursor
                page=await self.request(token,'/messages',params)
                if not permitted():break
                if not isinstance(page,dict) or not isinstance(page.get('messages',[]),list):raise AppError('Gmail 목록을 확인할 수 없어요.',502)
                stopped=False
                for message in page.get('messages',[]):
                    if counts['examined']>=10:
                        cursor=page_start;stopped=True;break
                    if not permitted():stopped=True;break
                    message_id=message.get('id') if isinstance(message,dict) else None
                    if not isinstance(message_id,str) or not message_id or len(message_id)>256:
                        counts['examined']+=1;counts['failed']+=1;continue
                    key=user+':'+message_id
                    if message_id in attempted or self.store.get('gmail-seen',key,user):continue
                    attempted.add(message_id);counts['examined']+=1
                    try:
                        mail=await self.request(token,'/messages/'+quote(message_id,safe=''))
                        if not permitted():stopped=True;break
                        payload=mail.get('payload',{});headers={h['name'].lower():h['value'] for h in payload.get('headers',[])}
                        text=mail_text(payload) or mail.get('snippet','')
                        if not text.strip():raise AppError('메일 본문이 없어요.')
                        received=None
                        try:
                            if mail.get('internalDate'):received=datetime.fromtimestamp(int(mail['internalDate'])/1000,timezone.utc).isoformat()
                            elif headers.get('date'):
                                dt=parsedate_to_datetime(headers['date'])
                                if dt.tzinfo:received=dt.isoformat()
                        except (ValueError,OverflowError,TypeError):pass
                        source_input={'kind':'gmail','title':headers.get('subject','제목 없는 메일')[:160],'text':text,'sender':headers.get('from','')[:300],'receivedAt':received,'messageId':mail['id'],'url':'https://mail.google.com/mail/u/0/#all/'+mail['id']}
                        if self.triage is not None:
                            decision=await self.triage(source_input)
                            if not permitted():stopped=True;break
                            if (not isinstance(decision,dict) or type(decision.get('actionable')) is not bool
                                    or not isinstance(decision.get('reason'),str) or not decision['reason'].strip()
                                    or len(decision['reason'])>240):
                                raise AppError('메일의 실행 필요성을 확인하지 못했어요.')
                            if not decision['actionable']:
                                with self.store.transaction():
                                    if self.store.get('gmail-seen',key,user) or not permitted():continue
                                    # Do not persist arbitrary classifier text, which can quote
                                    # private mail. Keep a content-free durable explanation.
                                    self.store.put('gmail-seen',{'id':key,'ownerId':user,'status':'skipped',
                                        'reason':'실행 계획이 필요한 내용으로 판단되지 않았어요.','createdAt':now()})
                                counts['skipped']+=1
                                continue
                        proposal=await self.analyze(source_input)
                        with self.store.transaction():
                            if self.store.get('gmail-seen',key,user) or not permitted():continue
                            source=self.plans.add_source(user,source_input)
                            self.plans.propose(user,source['id'],proposal)
                            self.store.put('gmail-seen',{'id':key,'ownerId':user,'sourceId':source['id']})
                        counts['imported']+=1
                    except Exception:counts['failed']+=1
                if stopped:break
                cursor=page.get('nextPageToken')
                if not cursor or counts['examined']>=10:break
            with self.store.transaction():
                if current_account():self.store.put('gmail-settings',{**self.settings(user),
                    **({'nextPageToken':cursor} if query is None else {}),'lastSync':now(),
                    'lastError':f"{counts['failed']}개 메일을 분석하지 못했어요. 다음 수집 때 다시 시도해요." if counts['failed'] else None})
            return counts
        except Exception as error:
            with self.store.transaction():
                if current_account():self.store.put('gmail-settings',{**self.settings(user),'lastError':error.message if isinstance(error,AppError) else '메일 수집 중 문제가 발생했어요.'})
            raise
        finally:self.active.discard(user)
    async def tick(self):
        for settings in self.store.all('gmail-settings'):
            if settings.get('enabled'):
                try:await self.collect(settings['ownerId'])
                except Exception:pass  # 사용자 설정 화면에 상태를 남기며 메일 본문은 로그에 출력하지 않는다.
