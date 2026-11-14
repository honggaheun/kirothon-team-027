import argparse
import base64
import os
import secrets
from pathlib import Path
from types import SimpleNamespace
import uvicorn
from dotenv import load_dotenv
from chaenggim.api import create_app

def main():
    load_dotenv(Path(__file__).resolve().parent/'.env')
    parser=argparse.ArgumentParser(description='LERO 로컬 개발 서버')
    parser.add_argument('--demo',action='store_true',help='로컬 체험 계정 허용')
    parser.add_argument('--port',type=int,default=int(os.getenv('PORT','4871')))
    args=parser.parse_args()
    cloud=bool(os.getenv('K_SERVICE'))
    if cloud and (args.demo or not os.getenv('TOKEN_ENCRYPTION_KEY')):raise RuntimeError('Cloud Run은 실제 인증과 암호화 키 설정이 필요합니다.')
    root=Path(__file__).resolve().parent;key=root/'.data'/'encryption.key'
    if not cloud:
        key.parent.mkdir(parents=True,exist_ok=True)
        if not key.exists() and not os.getenv('TOKEN_ENCRYPTION_KEY'):key.write_bytes(secrets.token_bytes(32))
    settings=SimpleNamespace(origin=os.getenv('APP_ORIGIN',f'http://127.0.0.1:{args.port}'),demo=args.demo,client_id=os.getenv('GOOGLE_CLIENT_ID',''),client_secret=os.getenv('GOOGLE_CLIENT_SECRET',''),encryption_key=base64.b64decode(os.environ['TOKEN_ENCRYPTION_KEY']) if os.getenv('TOKEN_ENCRYPTION_KEY') else key.read_bytes(),project=os.getenv('GCP_PROJECT','kirothon-2026-514702'),model=os.getenv('VERTEX_MODEL',''))
    store=None
    if cloud:
        from chaenggim.cloud_store import FirestoreStore
        store=FirestoreStore(settings.project,bucket=os.environ['SOURCE_BUCKET'])
    uvicorn.run(create_app(settings,store=store),host='0.0.0.0' if cloud else '127.0.0.1',port=args.port,log_level='warning',access_log=False)

if __name__=='__main__':main()
