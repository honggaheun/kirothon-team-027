import base64
import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlencode
from uuid import uuid4
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from google.auth import jwt
from .domain import AppError

SCOPES={'login':'openid email profile','calendar':'https://www.googleapis.com/auth/calendar.app.created','calendar_read':'https://www.googleapis.com/auth/calendar.readonly','gmail':'https://www.googleapis.com/auth/gmail.readonly','tasks':'https://www.googleapis.com/auth/tasks','drive':'https://www.googleapis.com/auth/drive.readonly'}
def digest(value):return hashlib.sha256(value.encode()).hexdigest()
def random():return secrets.token_urlsafe(32)

def verify_token(token,client_id,nonce,certs):
    try:
        if jwt.decode_header(token).get('alg')!='RS256':raise ValueError('algorithm')
        claims=jwt.decode(token,certs=certs,audience=client_id)
        if claims.get('iss') not in ('https://accounts.google.com','accounts.google.com') or not isinstance(claims.get('nonce'),str) or not hmac.compare_digest(claims['nonce'],nonce) or not isinstance(claims.get('sub'),str) or not claims['sub'] or claims.get('email_verified') is not True:raise ValueError('claims')
        return claims
    except Exception as error:raise AppError('Google 인증 정보를 확인할 수 없어요. 다시 로그인해 주세요.',401) from error

class OAuth:
    def __init__(self,store,settings,client):
        self.store=store;self.settings=settings;self.client=client
        self.cipher=AESGCM(settings.encryption_key)
    def seal(self,value,user):
        iv=secrets.token_bytes(12)
        return base64.b64encode(iv+self.cipher.encrypt(iv,json.dumps(value).encode(),user.encode())).decode()
    def open(self,value,user):
        data=base64.b64decode(value)
        return json.loads(self.cipher.decrypt(data[:12],data[12:],user.encode()))
    def begin(self,purpose='login',user=None):
        if not self.settings.client_id or not self.settings.client_secret:raise AppError('Google OAuth 클라이언트 설정이 필요해요.',503)
        if purpose not in SCOPES or purpose!='login' and not user:raise AppError('로그인 후 연결해 주세요.',401)
        flow_id,state,verifier,nonce=random(),random(),random(),random()
        self.store.put('oauth',{'id':digest(state),'ownerId':'@system','flowHash':digest(flow_id),'verifier':verifier,'nonce':nonce,'purpose':purpose,'userId':user,'expiresAt':time.time()+600})
        query={'client_id':self.settings.client_id,'redirect_uri':self.settings.origin+'/auth/callback','response_type':'code','scope':SCOPES['login']+('' if purpose=='login' else ' '+SCOPES[purpose]),'state':state,'nonce':nonce,'code_challenge':base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('='),'code_challenge_method':'S256','include_granted_scopes':'true'}
        if purpose!='login':query.update(access_type='offline',prompt='consent')
        return {'flowId':flow_id,'url':'https://accounts.google.com/o/oauth2/v2/auth?'+urlencode(query)}
    async def token_request(self,params):
        response=await self.client.post('https://oauth2.googleapis.com/token',data={**params,'client_id':self.settings.client_id,'client_secret':self.settings.client_secret},timeout=15)
        if response.status_code!=200:raise AppError('Google 연결이 만료됐어요. 설정에서 다시 연결해 주세요.',401)
        token=response.json()
        if not token.get('access_token'):raise AppError('Google 연결 권한을 확인할 수 없어요.',401)
        return token
    async def finish(self,state,code,cookie,current_user):
        with self.store.transaction():
            flow=self.store.get('oauth',digest(state),'@system') if isinstance(state,str) else None
            if not flow or not isinstance(cookie,str) or not hmac.compare_digest(flow['flowHash'],digest(cookie)) or flow['expiresAt']<=time.time():raise AppError('로그인 요청이 만료됐어요. 다시 시작해 주세요.',401)
            self.store.delete('oauth',flow['id'],'@system')
        if not code or flow['purpose']!='login' and current_user!=flow['userId']:raise AppError('로그인한 계정에서 다시 연결해 주세요.',401)
        connection_generation=None
        if flow['purpose']!='login':
            profile=self.store.get('users',flow['userId'],flow['userId'])
            if not profile or not profile.get('generation'):raise AppError('로그인이 변경됐어요. 다시 로그인해 주세요.',401)
            connection_generation=profile['generation']
        token=await self.token_request({'grant_type':'authorization_code','code':code,'redirect_uri':self.settings.origin+'/auth/callback','code_verifier':flow['verifier']})
        response=await self.client.get('https://www.googleapis.com/oauth2/v1/certs',timeout=10)
        if response.status_code!=200:raise AppError('Google 인증 서버에 연결할 수 없어요.',502)
        claims=verify_token(token.get('id_token',''),self.settings.client_id,flow['nonce'],response.json())
        if flow['purpose']!='login' and claims['sub']!=flow['userId']:raise AppError('로그인할 때와 같은 Google 계정으로 연결해 주세요.',409)
        granted=token.get('scope','').split()
        if flow['purpose']!='login' and SCOPES[flow['purpose']] not in granted:raise AppError('서비스 연결 권한이 승인되지 않았어요.',403)
        user={'id':claims['sub'],'ownerId':claims['sub'],'name':str(claims.get('name','사용자'))[:100],'email':claims.get('email','')}
        with self.store.transaction():
            prior_user=self.store.get('users',user['id'],user['id']) or {}
            if flow['purpose']!='login' and prior_user.get('generation')!=connection_generation:
                raise AppError('로그인이 변경됐어요. 다시 로그인해 주세요.',401)
            user['generation']=prior_user.get('generation') or str(uuid4())
            previous=self.store.get('google',user['id'],user['id'])
            old=self.open(previous['tokens'],user['id']) if previous else {}
            token.pop('id_token',None)
            saved={**old,**token,'refresh_token':token.get('refresh_token') or old.get('refresh_token'),'expiresAt':time.time()+token.get('expires_in',3600)}
            # Google's combined grants do not override locally disconnected services.
            enabled=set(previous.get('scopes',[]) if previous else [])
            enabled.update(set(SCOPES['login'].split()).intersection(granted))
            if flow['purpose']!='login':enabled.add(SCOPES[flow['purpose']])
            self.store.put('users',user)
            self.store.put('google',{'id':user['id'],'ownerId':user['id'],'tokens':self.seal(saved,user['id']),'scopes':sorted(enabled)})
            return {**self.create_session(user),'purpose':flow['purpose']}
    def create_session(self,user):
        if not user.get('generation'):
            user={**user,'generation':str(uuid4())}
            self.store.put('users',user)
        sid,csrf=random(),random()
        self.store.put('sessions',{'id':digest(sid),'ownerId':'@system','userId':user['id'],'csrf':csrf,'expiresAt':time.time()+86400})
        return {'sid':sid,'csrf':csrf,'user':user}
    def session(self,sid):
        if not isinstance(sid,str):return None
        doc=self.store.get('sessions',digest(sid),'@system')
        if not doc or doc['expiresAt']<=time.time():return None
        user=self.store.get('users',doc['userId'],doc['userId'])
        return {**doc,'user':user} if user else None
    def logout(self,sid):
        if sid:self.store.delete('sessions',digest(sid),'@system')
    async def access_token(self,user,purpose):
        google=self.store.get('google',user,user)
        profile=self.store.get('users',user,user)
        if not google or SCOPES[purpose] not in google['scopes']:raise AppError('설정에서 Google 서비스를 먼저 연결해 주세요.',409)
        token=self.open(google['tokens'],user)
        if token['expiresAt']>time.time()+60:return token['access_token']
        if not token.get('refresh_token'):raise AppError('Google 연결이 만료됐어요. 다시 연결해 주세요.',401)
        refreshed=await self.token_request({'grant_type':'refresh_token','refresh_token':token['refresh_token']})
        saved={**token,**refreshed,'expiresAt':time.time()+refreshed.get('expires_in',3600)}
        with self.store.transaction():
            current=self.store.get('google',user,user)
            current_profile=self.store.get('users',user,user)
            if not current or not current_profile or (profile and current_profile.get('generation')!=profile.get('generation')):raise AppError('로그인이 필요해요.',401)
            self.store.put('google',{**current,'tokens':self.seal(saved,user)})
        return saved['access_token']
    def connected(self,user):
        google=self.store.get('google',user,user)
        return {purpose:bool(google and scope in google['scopes']) for purpose,scope in SCOPES.items() if purpose!='login'}
    def disconnect(self,user,purpose):
        google=self.store.get('google',user,user)
        if google:self.store.put('google',{**google,'scopes':[s for s in google['scopes'] if s!=SCOPES[purpose]]})
        if purpose=='gmail':
            settings=self.store.get('gmail-settings',user,user)
            if settings:self.store.put('gmail-settings',{**settings,'enabled':False})
