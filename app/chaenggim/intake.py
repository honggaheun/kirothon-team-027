import asyncio
import base64
import http.client
import ipaddress
import json
import re
import socket
import ssl
from html.parser import HTMLParser
from urllib.parse import urlparse,urljoin
from uuid import UUID
from .domain import AppError

MAX_BYTES=4*1024*1024
async def validate_public_url(value,resolver=None):
    try:
        url=urlparse(value);host=url.hostname;port=url.port
        if url.scheme not in ('http','https') or not host or url.username or url.password or port not in (None,80,443) or host=='localhost' or host.endswith(('.localhost','.local','.internal')):raise ValueError()
        try:addresses=[str(ipaddress.ip_address(host))]
        except ValueError:
            if resolver:addresses=await resolver(host)
            else:addresses=list({result[4][0] for result in await asyncio.to_thread(socket.getaddrinfo,host,None,0,socket.SOCK_STREAM)})
        if not addresses or any(not ipaddress.ip_address(ip).is_global or getattr(ipaddress.ip_address(ip),'ipv4_mapped',None) is not None or ip.startswith('2002:') for ip in addresses):raise ValueError()
        return url,addresses[0]
    except (ValueError,TypeError,OSError) as error:raise AppError('로그인 없이 열리는 공개 웹사이트 링크만 가져올 수 있어요.') from error

def _download(url,address,payload=None):
    port=url.port or (443 if url.scheme=='https' else 80)
    connection=http.client.HTTPConnection(url.hostname,port,timeout=10)
    sock=socket.create_connection((address,port),timeout=10)
    if url.scheme=='https':
        try:sock=ssl.create_default_context().wrap_socket(sock,server_hostname=url.hostname)
        except BaseException:sock.close();raise
    connection.sock=sock
    try:
        headers={'User-Agent':'Chaenggim/0.1','Accept-Encoding':'identity','Accept':'text/html,text/plain,application/pdf,image/png,image/jpeg'}
        if payload is not None:headers['Content-Type']='application/json'
        connection.request('POST' if payload is not None else 'GET',(url.path or '/')+('?' + url.query if url.query else ''),body=json.dumps(payload).encode() if payload is not None else None,headers=headers)
        response=connection.getresponse()
        if response.status in (301,302,303,307,308):return {'redirect':response.getheader('location')}
        if response.status!=200:raise AppError('링크를 가져올 수 없어요. 내용을 복사해서 넣어 주세요.')
        data=response.read(MAX_BYTES+1)
        if len(data)>MAX_BYTES:raise AppError('자료는 4MB 이하로 올려 주세요.')
        return {'bytes':data,'mime':response.getheader('Content-Type','').split(';')[0].lower()}
    finally:connection.close()

async def fetch_public(value,depth=0):
    if depth>3:raise AppError('링크 이동이 너무 많아요. 최종 주소를 입력해 주세요.')
    url,address=await validate_public_url(value)
    try:result=await asyncio.wait_for(asyncio.to_thread(_download,url,address),15)
    except (OSError,TimeoutError,http.client.HTTPException) as error:raise AppError('링크 응답이 늦거나 가져올 수 없어요. 내용을 복사해서 넣어 주세요.') from error
    if 'redirect' in result:
        if not result['redirect']:raise AppError('링크 이동 주소가 없어요.')
        return await fetch_public(urljoin(value,result['redirect']),depth+1)
    return {**result,'url':value}

class TextParser(HTMLParser):
    def __init__(self):super().__init__(convert_charrefs=True);self.skip=0;self.chunks=[]
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style','noscript','svg'):self.skip+=1
        if tag in ('p','div','h1','h2','li','br','tr'):self.chunks.append('\n')
    def handle_endtag(self,tag):
        if tag in ('script','style','noscript','svg'):self.skip=max(0,self.skip-1)
    def handle_data(self,value):
        if not self.skip:self.chunks.append(value)
def html_text(value):
    parser=TextParser();parser.feed(value);return '\n'.join(line.strip() for line in ''.join(parser.chunks).splitlines() if line.strip())[:50000]

def notion_blocks_text(blocks,root):
    lines=[];seen=set()
    def visit(id):
        if id in seen or len(seen)>2000:return
        seen.add(id);block=blocks.get(id,{})
        while isinstance(block,dict) and 'value' in block:block=block['value']
        if not isinstance(block,dict):return
        for values in block.get('properties',{}).values():
            if isinstance(values,list):
                text=''.join(part[0] for part in values if isinstance(part,list) and part and isinstance(part[0],str))
                if text.strip():lines.append(text.strip())
        for child in block.get('content',[]):visit(child)
    visit(root)
    return '\n'.join(lines)[:50000]

async def public_notion_text(value):
    parsed=urlparse(value);match=re.search(r'([0-9a-fA-F]{32})(?:$|[/?])',parsed.path)
    if not match:raise AppError('Notion 공개 페이지 주소를 확인해 주세요.')
    page=str(UUID(match[1]));api_url=f'{parsed.scheme}://{parsed.netloc}/api/v3/loadPageChunk'
    blocks={};cursor={'stack':[]}
    for index in range(5):
        url,address=await validate_public_url(api_url)
        try:result=await asyncio.wait_for(asyncio.to_thread(_download,url,address,{'pageId':page,'limit':200,'cursor':cursor,'chunkNumber':index,'verticalColumns':False}),15)
        except (OSError,TimeoutError) as error:raise AppError('Notion 공지를 가져오지 못했어요. 캡처나 텍스트로 넣어 주세요.') from error
        if 'redirect' in result:raise AppError('로그인 없이 공개된 Notion 페이지를 넣어 주세요.')
        try:data=json.loads(result['bytes'])
        except (ValueError,KeyError) as error:raise AppError('Notion 공개 내용을 읽을 수 없어요.') from error
        blocks.update(data.get('recordMap',{}).get('block',{}));cursor=data.get('cursor',{})
        if not cursor.get('stack'):break
    text=notion_blocks_text(blocks,page)
    if len(text)<20:raise AppError('Notion 본문을 찾지 못했어요. 공개 설정을 확인하거나 캡처를 넣어 주세요.')
    return text
def binary(data,mime,name):
    good=(mime=='application/pdf' and data.startswith(b'%PDF-') or mime=='image/png' and data.startswith(b'\x89PNG\r\n\x1a\n') or mime=='image/jpeg' and data.startswith(b'\xff\xd8\xff'))
    if not good or not 0<len(data)<=MAX_BYTES:raise AppError('4MB 이하 PDF·PNG·JPEG 파일을 넣어 주세요.')
    return {'mime':mime,'data':base64.b64encode(data).decode(),'name':str(name or '첨부 자료')[:180],'text':''}
async def read_input(value):
    if not isinstance(value,dict) or value.get('kind') not in ('text','url','file','image'):raise AppError('자료 종류를 선택해 주세요.')
    kind=value['kind'];title=str(value.get('title') or value.get('name') or '새 공지').strip()[:160]
    if kind=='text':
        text=value.get('text')
        if not isinstance(text,str) or not text.strip() or len(text)>50000:raise AppError('공지 내용을 5만 자 이내로 입력해 주세요.')
        return {'kind':kind,'title':title,'text':text.strip()}
    if kind=='url':
        if not isinstance(value.get('url'),str) or len(value['url'])>2048:raise AppError('링크를 확인해 주세요.')
        host=urlparse(value['url']).hostname or ''
        if host in ('notion.so','www.notion.so') or host.endswith('.notion.site'):
            return {'kind':kind,'title':title,'url':value['url'],'text':await public_notion_text(value['url'])}
        result=await fetch_public(value['url']);mime=result['mime']
        if mime in ('application/pdf','image/png','image/jpeg'):return {'kind':kind,'title':title,'url':result['url'],**binary(result['bytes'],mime,title)}
        if mime not in ('text/plain','text/html'):raise AppError('이 링크 형식은 아직 지원하지 않아요. 내용을 복사하거나 PDF로 올려 주세요.')
        raw=result['bytes'].decode('utf-8',errors='replace');text=html_text(raw) if mime=='text/html' else raw[:50000]
        if not text.strip():raise AppError('링크에서 공지를 찾지 못했어요.')
        return {'kind':kind,'title':title,'url':result['url'],'text':text}
    data=value.get('data')
    if not isinstance(data,str) or len(data)>5600000:raise AppError('첨부 파일 용량을 확인해 주세요. 최대 4MB까지 가능해요.')
    try:decoded=base64.b64decode(data,validate=True)
    except ValueError as error:raise AppError('첨부 파일을 읽을 수 없어요.') from error
    if value.get('mime')=='text/plain':
        try:return await read_input({'kind':'text','title':title,'text':decoded.decode('utf-8')})
        except UnicodeDecodeError as error:raise AppError('텍스트 파일은 UTF-8로 저장해 주세요.') from error
    return {'kind':kind,'title':title,**binary(decoded,value.get('mime'),value.get('name'))}
