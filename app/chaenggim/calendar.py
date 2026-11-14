import hashlib
from datetime import datetime
from uuid import uuid4
from urllib.parse import quote
import httpx
from .domain import AppError,require

class Calendar:
    def __init__(self,store,oauth,client):self.store=store;self.oauth=oauth;self.client=client;self.active=set()
    async def request(self,token,path,method='GET',payload=None,etag=None):
        headers={'Authorization':'Bearer '+token}
        if etag:headers['If-Match']=etag
        try:return await self.client.request(method,'https://www.googleapis.com/calendar/v3'+path,headers=headers,json=payload,timeout=15)
        except httpx.HTTPError as error:raise AppError('Google 연결 응답을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',502) from error
    async def ensure_calendar(self,user,token):
        with self.store.transaction():
            integration=self.store.get('calendar',user,user)
            if integration and integration.get('calendarId'):return integration
            if integration and integration.get('status') in ('creating','unknown'):raise AppError('캘린더 생성 요청 결과를 확인해야 해요. Google Calendar에서 LERO 캘린더 ID를 확인하고 설정에 입력해 주세요.',409)
            claim={'id':user,'ownerId':user,'status':'creating','marker':str(uuid4())}
            self.store.put('calendar',claim)
        try:response=await self.request(token,'/calendars','POST',{'summary':'LERO','timeZone':'Asia/Seoul','description':'LERO에서 승인한 일정 · integration '+claim['marker']})
        except Exception:
            self.store.put('calendar',{**claim,'status':'unknown'});raise
        if response.status_code!=200:
            self.store.put('calendar',{**claim,'status':'failed'})
            raise AppError('전용 캘린더를 만들 수 없어요. 다시 연결해 주세요.',502)
        with self.store.transaction():
            current=require(self.store.get('calendar',user,user))
            if current.get('marker')!=claim['marker']:raise AppError('캘린더 연결 상태가 바뀌었어요. 새로고침해 주세요.',409)
            return self.store.put('calendar',{**claim,'status':'ready','calendarId':response.json()['id']})
    async def recover(self,user,calendar_id):
        current=require(self.store.get('calendar',user,user))
        if current.get('status') not in ('creating','unknown') or not isinstance(calendar_id,str) or len(calendar_id)>300:raise AppError('복구할 캘린더 연결을 확인해 주세요.')
        token=await self.oauth.access_token(user,'calendar');response=await self.request(token,'/calendars/'+quote(calendar_id,safe=''))
        if response.status_code!=200 or current['marker'] not in response.json().get('description',''):raise AppError('이 서비스에서 생성한 캘린더인지 확인할 수 없어요.')
        return self.store.put('calendar',{**current,'calendarId':calendar_id,'status':'ready'})
    @staticmethod
    def reflected(remote,payload):
        if remote.get('summary')!=payload['summary'] or remote.get('description','')!=payload['description']:return False
        if remote.get('extendedProperties',{}).get('private',{})!=payload['extendedProperties']['private']:return False
        if remote.get('reminders',{}).get('useDefault') is not False or remote.get('reminders',{}).get('overrides'):return False
        try:
            return all(datetime.fromisoformat(remote[k]['dateTime'].replace('Z','+00:00'))==datetime.fromisoformat(payload[k]['dateTime'].replace('Z','+00:00')) for k in ('start','end'))
        except (ValueError,KeyError,TypeError):return False
    async def sync(self,user,id):
        if user in self.active:raise AppError('동기화 중이에요. 잠시 후 다시 확인해 주세요.',409)
        self.active.add(user)
        try:
            item=require(self.store.get('items',id,user))
            if item.get('kind')!='event' or not item.get('approved') or not item.get('start') or not item.get('end'):raise AppError('시작·종료 시각을 확인한 일정만 연결할 수 있어요.')
            if (item.get('calendar') or {}).get('syncedVersion')==item['version']:return item
            token=await self.oauth.access_token(user,'calendar')
            integration=await self.ensure_calendar(user,token)
            event_id=hashlib.sha256((user+':'+id).encode()).hexdigest()
            base='/calendars/'+quote(integration['calendarId'],safe='')+'/events'
            payload={'summary':item['title'],'description':'LERO에서 확인하고 승인한 일정\n'+item.get('evidence',''),'start':{'dateTime':item['start'],'timeZone':'Asia/Seoul'},'end':{'dateTime':item['end'],'timeZone':'Asia/Seoul'},'extendedProperties':{'private':{'chaenggimItem':id,'chaenggimVersion':str(item['version'])}},'reminders':{'useDefault':False}}
            remote=item.get('calendar') or {};updating=bool(remote.get('etag'))
            response=await self.request(token,base+'/'+event_id if updating else base,'PATCH' if updating else 'POST',payload if updating else {**payload,'id':event_id},remote.get('etag') if updating else None)
            if (response.status_code==409 and not updating) or response.status_code==412:
                response=await self.request(token,base+'/'+event_id)
                if response.status_code==200:
                    if not self.reflected(response.json(),payload):raise AppError('Google Calendar에서 일정이 변경됐어요. 덮어쓰기 전에 직접 확인해 주세요.',409)
                else:raise AppError('Google Calendar에서 기존 일정을 확인할 수 없어요. 직접 확인해 주세요.',409)
            if response.status_code!=200:raise AppError('Google Calendar에 반영하지 못했어요. 연결 상태를 확인해 주세요.',502)
            found=response.json();current=require(self.store.get('items',id,user))
            return self.store.put('items',{**current,'calendar':{'calendarId':integration['calendarId'],'eventId':event_id,'etag':found.get('etag'),'htmlLink':found.get('htmlLink',remote.get('htmlLink')),'syncedVersion':item['version'],'status':'synced' if current['version']==item['version'] else 'pending'}})
        finally:self.active.discard(user)
