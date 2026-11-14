"""Fail-closed Model Armor input screening; never logs prompts or credentials.

The configured template must enable PIJ and both TEXT and IMAGE modalities.
Image/PDF image inspection requires an image-capable location such as ``us``.
"""
import asyncio
import base64
import binascii
import re

from .domain import AppError


MAX_TEXT_BYTES = 512 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024
UNAVAILABLE = '입력 보안 검사를 완료하지 못했어요. 잠시 후 다시 시도해 주세요.'
BLOCKED = '자료에서 AI의 지침을 바꾸려는 내용이 감지됐어요. 해당 내용을 확인하고 다시 입력해 주세요.'
_TEMPLATE = re.compile(
    r'projects/[a-zA-Z0-9][a-zA-Z0-9-]{0,62}/locations/'
    r'(?P<location>[a-z][a-z0-9-]{0,39})/templates/[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}'
)


class ModelArmor:
    def __init__(self, client, template, token_provider):
        match = _TEMPLATE.fullmatch(template) if isinstance(template, str) else None
        if not match:
            raise AppError('입력 보안 검사 설정을 확인해 주세요.', 503)
        self.client = client
        self.token_provider = token_provider
        self.url = f"https://modelarmor.{match['location']}.rep.googleapis.com/v1/{template}:sanitizeUserPrompt"

    @staticmethod
    def _text(value):
        if not isinstance(value, str):
            raise AppError('검사할 자료 내용을 확인해 주세요.')
        try:
            size = len(value.encode('utf-8'))
        except UnicodeEncodeError:
            raise AppError('검사할 자료 내용을 확인해 주세요.') from None
        if size > MAX_TEXT_BYTES:
            raise AppError('검사할 텍스트가 너무 커요. 자료를 나누어 입력해 주세요.', 413)
        return value

    async def _inspect(self, data):
        try:
            async with asyncio.timeout(30):
                token = await self.token_provider()
                if not isinstance(token, str) or not token:
                    raise ValueError('missing credentials')
                response = await self.client.post(
                    self.url, headers={'Authorization': 'Bearer ' + token},
                    json={'userPromptData': data,
                          'multiLanguageDetectionMetadata': {'enableMultiLanguageDetection': True}},
                    timeout=25, follow_redirects=False,
                )
                if response.status_code != 200:
                    raise ValueError('inspection unavailable')
                payload = response.json()
            result = payload['sanitizationResult']
            pij = result['filterResults']['pi_and_jailbreak']['piAndJailbreakFilterResult']
            if (result.get('invocationResult') != 'SUCCESS'
                    or pij.get('executionState') != 'EXECUTION_SUCCESS'
                    or pij.get('messageItems', []) != []
                    or result.get('filterMatchState') not in ('NO_MATCH_FOUND', 'MATCH_FOUND')
                    or pij.get('matchState') not in ('NO_MATCH_FOUND', 'MATCH_FOUND')):
                raise ValueError('inspection incomplete')
            blocked = result['filterMatchState'] == 'MATCH_FOUND' or pij['matchState'] == 'MATCH_FOUND'
        except Exception:
            # Remote bodies and provider exceptions can contain input or credentials.
            raise AppError(UNAVAILABLE, 503) from None
        if blocked:
            raise AppError(BLOCKED, 400)

    async def check_text(self, text):
        text = self._text(text)
        if text.strip():
            await self._inspect({'text': text})

    async def check_source(self, source):
        if not isinstance(source, dict):
            raise AppError('검사할 자료 내용을 확인해 주세요.')
        title = self._text(source.get('title', ''))
        body = self._text(source.get('text', ''))
        text = self._text('\n'.join(part for part in (title, body) if part.strip()))
        attachment = None
        if 'data' in source:
            encoded = source['data']
            if not isinstance(encoded, str) or not encoded:
                raise AppError('첨부 파일을 읽을 수 없어요.')
            if len(encoded) > 4 * ((MAX_FILE_BYTES + 2) // 3):
                raise AppError('첨부 파일은 4MB 이하로 올려 주세요.', 413)
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                raise AppError('첨부 파일을 읽을 수 없어요.') from None
            if len(raw) > MAX_FILE_BYTES:
                raise AppError('첨부 파일은 4MB 이하로 올려 주세요.', 413)
            mime = source.get('mime')
            if mime == 'application/pdf' and raw.startswith(b'%PDF-'):
                kind = 'PDF'
            elif ((mime == 'image/png' and raw.startswith(b'\x89PNG\r\n\x1a\n'))
                  or (mime == 'image/jpeg' and raw.startswith(b'\xff\xd8\xff'))):
                kind = 'IMAGE'
            else:
                raise AppError('보안 검사는 PDF·PNG·JPEG 첨부 파일을 지원해요.')
            attachment = {'byteItem': {'byteDataType': kind, 'byteData': encoded}}
        elif (source.get('_blob') or source.get('kind') in ('image', 'file')
              or source.get('mime') in ('application/pdf', 'image/png', 'image/jpeg')):
            # A storage reference is not inspected content. The caller must load it.
            raise AppError(UNAVAILABLE, 503)
        if text.strip():
            await self._inspect({'text': text})
        if attachment is not None:
            await self._inspect(attachment)
