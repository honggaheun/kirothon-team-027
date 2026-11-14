import hashlib
import json
from datetime import datetime, timezone
from uuid import uuid4
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from .rules import RULES, check, timestamp

class AppError(Exception):
    def __init__(self,message,status=400): self.message=message; self.status=status; super().__init__(message)
def require(doc):
    if doc is None: raise AppError('자료를 찾을 수 없어요.',404)
    return doc
def now(): return datetime.now(timezone.utc).isoformat()

class PlanItem(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    title:str=Field(min_length=1,max_length=160)
    kind:Literal['event','task']
    start:str|None=None
    end:str|None=None
    origin:Literal['source','suggested']='source'
    evidence:str=Field(default='',max_length=1200)
    page:int|None=Field(default=None,ge=1,le=200)
    reminders:list[str]=Field(default_factory=list,max_length=3)
    replacesId:str|None=None
    key:str=''
    @field_validator('title')
    @classmethod
    def nonempty(cls,value):
        if not value.strip(): raise ValueError('빈 제목')
        return value.strip()
    @field_validator('start','end')
    @classmethod
    def valid_date(cls,value):
        if value is not None and not timestamp(value): raise ValueError('잘못된 날짜')
        return value

class Proposal(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    title:str=Field(min_length=1,max_length=160)
    summary:str=Field(max_length=4000)
    questions:list[str]=Field(max_length=10)
    items:list[PlanItem]=Field(min_length=1,max_length=40)

def validate_proposal(proposal,source):
    try: clean=Proposal.model_validate(proposal).model_dump()
    except ValidationError as error: raise AppError('분석 결과의 날짜와 항목을 확인할 수 없어요. 다시 분석해 주세요.') from error
    text=''.join(source.get('text','').split())
    for index,item in enumerate(clean['items']):
        if text and item['evidence'] and ''.join(item['evidence'].split()) not in text: raise AppError('원문에서 확인되지 않은 근거가 있어요. 다시 분석해 주세요.')
        item['key']=str(index)
        if item['kind']=='task' and item['end'] and not item['start']:
            item['start'],item['end']=item['end'],None
    return clean
def fingerprint(item): return hashlib.sha256(json.dumps([item['title'].strip(),item['kind'],item.get('start')],ensure_ascii=False).encode()).hexdigest()

class Plans:
    def __init__(self,store): self.store=store
    def add_source(self,user,input): return self.store.put('sources',{**input,'id':str(uuid4()),'ownerId':user,'version':1,'createdAt':now()})
    def propose(self,user,source_id,proposal):
        source=require(self.store.get('sources',source_id,user))
        clean=validate_proposal(proposal,source)
        return self.store.put('drafts',{**clean,'id':str(uuid4()),'ownerId':user,'sourceId':source_id,'sourceVersion':source['version'],'version':1,'status':'draft','createdAt':now()})
    def edit(self,user,id,version,items):
        with self.store.transaction():
            draft=require(self.store.get('drafts',id,user))
            if draft['status']!='draft' or version!=draft['version']: raise AppError(RULES['R3.1'],409)
            if not isinstance(items,list) or not 1<=len(items)<=len(draft['items']): raise AppError('등록할 항목을 하나 이상 선택해 주세요.')
            keys=[i.get('key') for i in items if isinstance(i,dict)]
            if len(keys)!=len(items) or len(set(keys))!=len(keys):raise AppError('항목 식별자를 확인해 주세요.')
            originals={i['key']:i for i in draft['items']}
            for new in items:
                old=originals.get(new['key'])
                if old is None or any(old.get(k)!=new.get(k) for k in ['key','origin','evidence','kind','page']): raise AppError('원문 근거와 항목 식별자는 변경할 수 없어요.')
                if new.get('replacesId'):
                    previous=require(self.store.get('items',new['replacesId'],user))
                    if previous['sourceId']!=draft['sourceId'] or previous['kind']!=new['kind']:raise AppError('같은 자료의 같은 종류 항목만 수정할 수 있어요.')
            clean=validate_proposal({'title':draft['title'],'summary':draft['summary'],'questions':draft['questions'],'items':items},{})
            for item,key in zip(clean['items'],keys):item['key']=key
            return self.store.put('drafts',{**draft,'items':clean['items'],'version':draft['version']+1})
    def approve(self,user,id,version):
        with self.store.transaction():
            draft=require(self.store.get('drafts',id,user))
            if draft['status']=='approved': return {'draft':draft,'items':[self.store.get('items',i,user) for i in draft['itemIds']]}
            source=require(self.store.get('sources',draft['sourceId'],user))
            if source['version']!=draft['sourceVersion']: raise AppError(RULES['R3.1'],409)
            current=self.store.list('items',user)
            replacements=[i['replacesId'] for i in draft['items'] if i.get('replacesId')]
            if len(set(replacements))!=len(replacements):raise AppError('여러 항목이 같은 기존 업무를 수정하고 있어요. 연결을 확인해 주세요.',409)
            duplicate=len({fingerprint(i) for i in draft['items']})!=len(draft['items']) or any(fingerprint(i)==old.get('fingerprint') and old['id']!=i.get('replacesId') for i in draft['items'] for old in current)
            result=check({'userId':user,'ownerId':draft['ownerId'],'approved':True,'version':draft['version'],'expectedVersion':version,'duplicate':duplicate,'items':draft['items']})
            if not result['ok']: raise AppError(RULES[result['reason']],409)
            saved=[]
            for item in draft['items']:
                previous=require(self.store.get('items',item['replacesId'],user)) if item.get('replacesId') else {}
                if previous and (previous['sourceId']!=source['id'] or previous['kind']!=item['kind']): raise AppError('같은 자료의 같은 종류 항목만 수정할 수 있어요.')
                remote=previous.get('calendar'); remote={**remote,'status':'pending'} if remote else None
                saved.append(self.store.put('items',{**previous,**item,'id':previous.get('id',str(uuid4())),'ownerId':user,'sourceId':source['id'],'draftId':id,'approved':True,'version':previous.get('version',0)+1,'fingerprint':fingerprint(item),'done':previous.get('done',False),'calendar':remote,'createdAt':previous.get('createdAt',now()),'updatedAt':now()}))
            self.store.put('sources',{**source,'title':draft['title']})
            approved=self.store.put('drafts',{**draft,'status':'approved','itemIds':[i['id'] for i in saved]})
            return {'draft':approved,'items':saved}
    def complete(self,user,id,done):
        with self.store.transaction():
            item=require(self.store.get('items',id,user))
            if item['kind']!='task' or not isinstance(done,bool): raise AppError('할 일 완료 여부를 확인해 주세요.')
            return self.store.put('items',{**item,'done':done,'reminders':[] if done else item.get('reminders',[]),'version':item['version']+1})
