"""Server-side Google Tasks sync and read-only Drive file import.

Tasks does not accept caller-chosen IDs. Durable creation attempts and markers
therefore survive network errors; an uncertain insert is reconciled, never
repeated merely because its response was lost.
"""
import base64
import re
import time
from urllib.parse import quote, urlparse
from uuid import uuid4

import httpx

from .domain import AppError, require
from .intake import MAX_BYTES, read_input
from .rules import KST, timestamp


TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1'
DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files'
DOC_MIME = 'application/vnd.google-apps.document'
SUPPORTED_MIMES = ('application/pdf', 'image/png', 'image/jpeg', 'text/plain', DOC_MIME)
FILE_FIELDS = 'id,name,mimeType,size,webViewLink,modifiedTime,trashed,capabilities(canDownload)'
CLAIM_SECONDS = 90


class _GoogleError(AppError):
    def __init__(self, message, status=502, uncertain=False):
        super().__init__(message, status)
        self.uncertain = uncertain


def _check_response(response, product):
    code = response.status_code
    if code == 200:
        return
    if code in (401, 403):
        raise _GoogleError(f'{product} 권한을 확인할 수 없어요. 설정에서 다시 연결해 주세요.', code)
    if code == 404:
        raise _GoogleError(f'{product} 자료를 찾을 수 없거나 접근 권한이 없어요.', 404)
    if code in (409, 412):
        raise _GoogleError(f'{product}에서 내용이 변경됐어요. 확인 후 다시 시도해 주세요.', 409)
    if code == 429:
        raise _GoogleError(f'{product} 요청이 많아요. 잠시 후 다시 시도해 주세요.', 503, uncertain=True)
    raise _GoogleError(f'{product} 요청을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.',
                       502 if code >= 500 or 300 <= code < 400 else 400,
                       uncertain=code >= 500 or 300 <= code < 400)


async def _json_request(client, method, url, token, product, **kwargs):
    headers = {'Authorization': 'Bearer ' + token, **kwargs.pop('headers', {})}
    try:
        response = await client.request(method, url, headers=headers, timeout=15,
                                        follow_redirects=False, **kwargs)
    except httpx.RequestError as error:
        raise _GoogleError(f'{product} 응답을 확인하지 못했어요. 잠시 후 다시 확인해 주세요.',
                           uncertain=True) from error
    _check_response(response, product)
    try:
        value = response.json()
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except ValueError as error:
        raise _GoogleError(f'{product} 응답을 확인할 수 없어요.', uncertain=True) from error


def _remote_id(value):
    if not isinstance(value, str) or not value or len(value) > 1024 or any(ord(c) < 32 for c in value):
        raise _GoogleError('Google 자료 식별자를 확인할 수 없어요.', uncertain=True)
    return value


def _safe_link(value, hosts=None):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 32 for c in value):
        return None
    try:
        parsed = urlparse(value)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            return None
        if hosts and parsed.hostname not in hosts:
            return None
    except ValueError:
        return None
    return value


class GoogleTasks:
    def __init__(self, store, oauth, client):
        self.store, self.oauth, self.client = store, oauth, client

    async def list_items(self, user, query=''):
        """Read this OAuth user's pending tasks, without reading/writing local data.

        Scan at most 10 lists and 20 tasks per list, with three pages per
        collection and 50 returned items. An incomplete scan is explicit.
        """
        if not isinstance(query, str) or len(query) > 200 or any(ord(c) < 32 for c in query):
            raise AppError('할 일 검색어를 200자 이내로 입력해 주세요.')
        literal = query.strip().casefold()
        token = await self.oauth.access_token(user, 'tasks')

        async def bounded_pages(path, limit, params):
            rows, seen_tokens, page_token = [], set(), None
            truncated = False
            for _ in range(3):
                page = await _json_request(
                    self.client, 'GET', TASKS_BASE + path, token, 'Google Tasks',
                    params={**params, 'maxResults': limit - len(rows),
                            **({'pageToken': page_token} if page_token else {})})
                batch = page.get('items', [])
                if not isinstance(batch, list) or any(not isinstance(row, dict) for row in batch):
                    raise _GoogleError('Google Tasks 목록을 확인할 수 없어요.')
                remaining = limit - len(rows)
                truncated = truncated or len(batch) > remaining
                rows.extend(batch[:remaining])
                page_token = page.get('nextPageToken')
                if not page_token:
                    return rows, truncated
                if not isinstance(page_token, str) or len(page_token) > 4096 or any(ord(c) < 32 for c in page_token):
                    raise _GoogleError('Google Tasks 다음 페이지 정보를 확인할 수 없어요.')
                if len(rows) >= limit or page_token in seen_tokens:
                    return rows, True
                seen_tokens.add(page_token)
            return rows, True

        lists, truncated = await bounded_pages('/users/@me/lists', 10,
                                               {'fields': 'nextPageToken,items(id,title)'})
        items, seen_lists, seen_items = [], set(), set()
        fields = 'nextPageToken,items(id,title,due,status,updated,webViewLink,hidden,deleted)'
        for list_index, task_list in enumerate(lists):
            list_id = _remote_id(task_list.get('id'))
            if list_id in seen_lists:
                continue
            seen_lists.add(list_id)
            list_title = task_list.get('title')
            list_title = list_title[:1024] if isinstance(list_title, str) else ''
            rows, more_tasks = await bounded_pages(
                '/lists/' + quote(list_id, safe='') + '/tasks', 20,
                {'showCompleted': 'false', 'showHidden': 'false', 'showDeleted': 'false', 'fields': fields})
            truncated = truncated or more_tasks
            for row_index, remote in enumerate(rows):
                title = remote.get('title')
                if (not isinstance(title, str) or remote.get('status') != 'needsAction'
                        or remote.get('hidden') or remote.get('deleted') or literal not in title.casefold()):
                    continue
                task_id = _remote_id(remote.get('id'))
                key = (list_id, task_id)
                if key in seen_items:
                    continue
                seen_items.add(key)
                item = {'id': task_id, 'title': title[:1024], 'status': 'needsAction',
                        'listTitle': list_title}
                for field in ('due', 'updated'):
                    value = remote.get(field)
                    item[field] = value if isinstance(value, str) and len(value) <= 64 else None
                link = _safe_link(remote.get('webViewLink'), {'tasks.google.com'})
                if link:
                    item['webViewLink'] = link
                items.append(item)
                if len(items) == 50:
                    return {'items': items, 'truncated': bool(
                        truncated or row_index + 1 < len(rows) or list_index + 1 < len(lists))}
        return {'items': items, 'truncated': bool(truncated)}

    def _item(self, user, item_id, claim=None):
        item = require(self.store.get('items', item_id, user))
        if item.get('ownerId') != user:
            raise AppError('본인의 할 일만 연결할 수 있어요.', 404)
        if item.get('approved') is not True:
            raise AppError('계획을 먼저 확인하고 승인해 주세요.', 409)
        if item.get('kind') != 'task':
            raise AppError('할 일만 Google Tasks에 연결할 수 있어요.')
        if claim and (item.get('tasks') or {}).get('claimId') != claim:
            raise AppError('다른 연결 작업이 먼저 반영됐어요. 다시 확인해 주세요.', 409)
        return item

    def _checkpoint(self, user, item_id, claim, version):
        with self.store.transaction():
            item = self._item(user, item_id, claim)
            if item['version'] != version:
                raise AppError('할 일이 변경됐어요. 새로고침 후 다시 연결해 주세요.', 409)
            self.store.put('items', {**item, 'tasks': {**item['tasks'], 'claimUntil': time.time() + CLAIM_SECONDS}})
        return item

    def _claim(self, user, item_id):
        with self.store.transaction():
            item = self._item(user, item_id)
            remote = item.get('tasks') or {}
            if remote.get('status') == 'synced' and remote.get('syncedVersion') == item['version']:
                return item, None
            if remote.get('claimId') and remote.get('claimUntil', 0) > time.time():
                raise AppError('이 할 일을 연결하고 있어요. 잠시 후 다시 확인해 주세요.', 409)
            claim = str(uuid4())
            saved = self.store.put('items', {**item, 'tasks': {
                **remote, 'marker': remote.get('marker') or '[chaenggim:' + str(uuid4()) + ']',
                'claimId': claim, 'claimUntil': time.time() + CLAIM_SECONDS, 'status': 'syncing'}})
            return saved, claim

    def _release(self, user, item_id, claim):
        with self.store.transaction():
            item = self.store.get('items', item_id, user)
            remote = (item or {}).get('tasks') or {}
            if not item or remote.get('claimId') != claim:
                return
            remote = {key: value for key, value in remote.items() if key not in ('claimId', 'claimUntil')}
            if remote.get('status') == 'syncing':
                remote['status'] = 'pending'
            self.store.put('items', {**item, 'tasks': remote})

    async def _call(self, user, item, claim, token, method, path, **kwargs):
        self._checkpoint(user, item['id'], claim, item['version'])
        return await _json_request(self.client, method, TASKS_BASE + path, token, 'Google Tasks', **kwargs)

    async def _pages(self, user, item, claim, token, path, params):
        found, seen, page_token = [], set(), None
        # 2,000 lists or 20,000 visible tasks fit within these bounds. Never
        # conclude "not found" when pagination is incomplete.
        for _ in range(1000):
            page = await self._call(user, item, claim, token, 'GET', path,
                                    params={**params, **({'pageToken': page_token} if page_token else {})})
            self._checkpoint(user, item['id'], claim, item['version'])
            rows = page.get('items', [])
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise _GoogleError('Google Tasks 목록을 확인할 수 없어요.')
            found.extend(rows)
            page_token = page.get('nextPageToken')
            if not page_token:
                return found
            if not isinstance(page_token, str) or len(page_token) > 4096 or page_token in seen:
                raise _GoogleError('Google Tasks 목록을 끝까지 확인하지 못했어요.')
            seen.add(page_token)
        raise AppError('Google Tasks 목록이 너무 많아요. 목록을 정리한 후 다시 연결해 주세요.', 409)

    def _list_mapping(self, user, item, claim):
        with self.store.transaction():
            self._item(user, item['id'], claim)
            mapping = self.store.get('tasks', user, user)
            if mapping and mapping.get('listId'):
                return mapping, None
            if mapping and mapping.get('claimId') and mapping.get('claimUntil', 0) > time.time():
                raise AppError('LERO 할 일 목록을 연결하고 있어요. 잠시 후 다시 확인해 주세요.', 409)
            list_claim = str(uuid4())
            marker = (mapping or {}).get('marker') or str(uuid4())
            mapping = {**(mapping or {}), 'id': user, 'ownerId': user, 'marker': marker,
                       'title': (mapping or {}).get('title') or f'LERO [chaenggim:{marker}]',
                       'claimId': list_claim, 'claimUntil': time.time() + CLAIM_SECONDS}
            self.store.put('tasks', mapping)
            return mapping, list_claim

    def _list_update(self, user, item, claim, list_claim, **changes):
        with self.store.transaction():
            self._item(user, item['id'], claim)
            mapping = require(self.store.get('tasks', user, user))
            if mapping.get('claimId') != list_claim:
                raise AppError('할 일 목록 연결이 변경됐어요. 다시 확인해 주세요.', 409)
            return self.store.put('tasks', {**mapping, **changes})

    async def _ensure_list(self, user, item, claim, token):
        mapping, list_claim = self._list_mapping(user, item, claim)
        if not list_claim:
            return _remote_id(mapping['listId'])
        try:
            lists = await self._pages(user, item, claim, token, '/users/@me/lists', {'maxResults': 1000})
            matches = [remote for remote in lists if remote.get('title') == mapping['title']]
            if len(matches) > 1:
                raise AppError('같은 LERO 목록이 여러 개 있어요. Google Tasks에서 목록을 확인해 주세요.', 409)
            if matches:
                list_id = _remote_id(matches[0].get('id'))
            else:
                if mapping.get('createAttempted'):
                    raise AppError('이전 목록 생성 결과를 확인 중이에요. Google Tasks에서 LERO 목록을 확인한 후 다시 시도해 주세요.', 409)
                self._list_update(user, item, claim, list_claim, createAttempted=True)
                try:
                    remote = await self._call(user, item, claim, token, 'POST', '/users/@me/lists',
                                              json={'title': mapping['title']})
                except _GoogleError as error:
                    if not error.uncertain:
                        self._list_update(user, item, claim, list_claim, createAttempted=False)
                    raise
                list_id = _remote_id(remote.get('id'))
            self._list_update(user, item, claim, list_claim, listId=list_id)
            return list_id
        finally:
            with self.store.transaction():
                latest = self.store.get('tasks', user, user)
                if latest and latest.get('claimId') == list_claim:
                    self.store.put('tasks', {key: value for key, value in latest.items()
                                             if key not in ('claimId', 'claimUntil')})

    def _payload(self, user, item):
        source = self.store.get('sources', item.get('sourceId'), user) if item.get('sourceId') else None
        notes = []
        if item.get('evidence'):
            notes.append('원문 근거: ' + str(item['evidence'])[:1200])
        if item.get('start'):
            notes.append('원래 일시: ' + item['start'] + ' (Google Tasks에는 한국 날짜만 반영)')
        origin = getattr(getattr(self.oauth, 'settings', None), 'origin', '').rstrip('/')
        if origin and item.get('sourceId'):
            notes.append('LERO 자료: ' + origin + '/#source/' + quote(item['sourceId'], safe=''))
        if source:
            link = _safe_link(source.get('url'))
            if link:
                notes.append('원본 자료: ' + link)
        notes.extend([f"LERO 항목 ID: {item['id']} / 버전: {item['version']}", item['tasks']['marker']])
        start = timestamp(item.get('start')) if item.get('start') else None
        if item.get('start') and not start:
            raise AppError('할 일 날짜를 확인해 주세요.')
        payload = {'title': item['title'], 'notes': '\n\n'.join(notes),
                   'status': 'completed' if item.get('done') else 'needsAction',
                   'due': start.astimezone(KST).date().isoformat() + 'T00:00:00.000Z' if start else None}
        if not item.get('done'):
            payload['completed'] = None
        return payload

    @staticmethod
    def _matches(remote, payload):
        return (all(remote.get(key) == payload.get(key) for key in ('title', 'notes', 'status'))
                and (remote.get('due') or '')[:10] == (payload.get('due') or '')[:10])

    def _remember(self, user, item, claim, **changes):
        with self.store.transaction():
            latest = self._item(user, item['id'], claim)
            return self.store.put('items', {**latest, 'tasks': {**latest['tasks'], **changes}})

    def _finish(self, user, item, claim, list_id, remote):
        task_id = _remote_id(remote.get('id'))
        with self.store.transaction():
            latest = self._item(user, item['id'], claim)
            metadata = {key: value for key, value in latest['tasks'].items()
                        if key not in ('claimId', 'claimUntil')}
            metadata.update(taskId=task_id, listId=list_id, syncedVersion=item['version'],
                            status='synced' if latest['version'] == item['version'] else 'pending')
            if remote.get('etag'):
                metadata['etag'] = remote['etag']
            link = _safe_link(remote.get('webViewLink'), {'tasks.google.com'})
            if link:
                metadata['webViewLink'] = link
            saved = self.store.put('items', {**latest, 'tasks': metadata})
        if latest['version'] != item['version']:
            raise AppError('연결 중 할 일이 변경됐어요. 최신 내용을 다시 연결해 주세요.', 409)
        return saved

    async def sync(self, user, item_id):
        item, claim = self._claim(user, item_id)
        if not claim:
            return item
        try:
            token = await self.oauth.access_token(user, 'tasks')
            self._checkpoint(user, item_id, claim, item['version'])
            list_id = await self._ensure_list(user, item, claim, token)
            current = self._checkpoint(user, item_id, claim, item['version'])
            metadata = current['tasks']
            payload = self._payload(user, item)
            tasks_path = '/lists/' + quote(list_id, safe='') + '/tasks'
            task_id = metadata.get('taskId')
            if task_id:
                if metadata.get('listId') != list_id:
                    raise AppError('Google Tasks 목록 연결이 변경됐어요. 설정을 확인해 주세요.', 409)
                try:
                    remote = await self._call(user, item, claim, token, 'GET', tasks_path + '/' + quote(_remote_id(task_id), safe=''))
                except _GoogleError as error:
                    if error.status == 404:
                        raise AppError('Google Tasks에서 할 일이 삭제됐거나 목록을 찾을 수 없어요.', 409) from error
                    raise
            else:
                tasks = await self._pages(user, item, claim, token, tasks_path,
                                         {'maxResults': 100, 'showCompleted': 'true', 'showHidden': 'true', 'showDeleted': 'true'})
                matches = [remote for remote in tasks if item['tasks']['marker'] in str(remote.get('notes', '')).splitlines()]
                if len(matches) > 1:
                    raise AppError('같은 LERO 할 일이 여러 개 있어요. Google Tasks에서 확인해 주세요.', 409)
                if not matches:
                    if metadata.get('createAttempted'):
                        raise AppError('이전 할 일 생성 결과를 확인 중이에요. 잠시 후 다시 확인해 주세요.', 409)
                    self._remember(user, item, claim, createAttempted=True, listId=list_id)
                    try:
                        remote = await self._call(user, item, claim, token, 'POST', tasks_path, json=payload)
                    except _GoogleError as error:
                        if not error.uncertain:
                            self._remember(user, item, claim, createAttempted=False)
                        raise
                    return self._finish(user, item, claim, list_id, remote)
                remote = matches[0]
                task_id = _remote_id(remote.get('id'))
                self._remember(user, item, claim, taskId=task_id, listId=list_id)
            self._checkpoint(user, item_id, claim, item['version'])
            if remote.get('deleted'):
                raise AppError('Google Tasks에서 할 일이 삭제됐어요. 연결을 확인해 주세요.', 409)
            if self._matches(remote, payload):
                return self._finish(user, item, claim, list_id, remote)
            if metadata.get('etag') and remote.get('etag') != metadata['etag']:
                raise AppError('Google Tasks에서 할 일이 변경됐어요. 내용을 확인해 주세요.', 409)
            etag = remote.get('etag')
            if not isinstance(etag, str) or not etag:
                raise _GoogleError('Google Tasks 변경 정보를 확인할 수 없어요.')
            remote = await self._call(user, item, claim, token, 'PATCH',
                                      tasks_path + '/' + quote(_remote_id(task_id), safe=''),
                                      json=payload, headers={'If-Match': etag})
            return self._finish(user, item, claim, list_id, remote)
        finally:
            self._release(user, item_id, claim)


class GoogleDrive:
    def __init__(self, store, oauth, client):
        self.store, self.oauth, self.client = store, oauth, client

    @staticmethod
    def _file_id(value):
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', value):
            raise AppError('Google Drive 파일 식별자를 확인해 주세요.')
        return value

    @staticmethod
    def _metadata(file):
        allowed = ('id', 'name', 'mimeType', 'size', 'modifiedTime')
        metadata = {key: file[key] for key in allowed if key in file}
        link = _safe_link(file.get('webViewLink'), {'drive.google.com', 'docs.google.com'})
        if link:
            metadata['webViewLink'] = link
        return metadata

    async def list_files(self, user, query='', page_token=None):
        if not isinstance(query, str) or len(query) > 200 or any(ord(c) < 32 for c in query):
            raise AppError('파일 검색어를 200자 이내로 입력해 주세요.')
        if page_token is not None and (not isinstance(page_token, str) or not 1 <= len(page_token) <= 2048
                                       or any(ord(c) < 32 for c in page_token)):
            raise AppError('Google Drive 다음 페이지 정보를 확인해 주세요.')
        escaped = query.strip().replace('\\', '\\\\').replace("'", "\\'")
        q = 'trashed = false and (' + ' or '.join(f"mimeType = '{mime}'" for mime in SUPPORTED_MIMES) + ')'
        if escaped:
            q += f" and name contains '{escaped}'"
        params = {'q': q, 'pageSize': 20, 'fields': 'nextPageToken,files(' + FILE_FIELDS + ')',
                  'orderBy': 'modifiedTime desc', 'spaces': 'drive'}
        if page_token:
            params['pageToken'] = page_token
        token = await self.oauth.access_token(user, 'drive')
        page = await _json_request(self.client, 'GET', DRIVE_BASE, token, 'Google Drive', params=params)
        files = page.get('files', [])
        if not isinstance(files, list) or any(not isinstance(file, dict) for file in files):
            raise AppError('Google Drive 파일 목록을 확인할 수 없어요.', 502)
        return {'files': [self._metadata(file) for file in files[:20]
                          if file.get('mimeType') in SUPPORTED_MIMES and not file.get('trashed')],
                'nextPageToken': page.get('nextPageToken')}

    async def _download(self, url, token, params):
        try:
            async with self.client.stream('GET', url, params=params,
                                          headers={'Authorization': 'Bearer ' + token, 'Accept-Encoding': 'identity'},
                                          timeout=20, follow_redirects=False) as response:
                _check_response(response, 'Google Drive')
                length = response.headers.get('Content-Length')
                if length is not None:
                    try:
                        if int(length) < 0 or int(length) > MAX_BYTES:
                            raise AppError('자료는 4MB 이하로 가져와 주세요.')
                    except ValueError as error:
                        raise AppError('Google Drive 파일 용량을 확인할 수 없어요.', 502) from error
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(data) + len(chunk) > MAX_BYTES:
                        raise AppError('자료는 4MB 이하로 가져와 주세요.')
                    data.extend(chunk)
                return bytes(data)
        except httpx.RequestError as error:
            raise AppError('Google Drive 파일을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.', 502) from error

    async def import_file(self, user, file_id):
        file_id = self._file_id(file_id)
        token = await self.oauth.access_token(user, 'drive')
        url = DRIVE_BASE + '/' + file_id
        metadata = await _json_request(self.client, 'GET', url, token, 'Google Drive', params={'fields': FILE_FIELDS})
        mime = metadata.get('mimeType')
        if metadata.get('id') != file_id or metadata.get('trashed') or mime not in SUPPORTED_MIMES:
            raise AppError('PDF·PNG·JPEG·텍스트·Google 문서 파일만 가져올 수 있어요.')
        if metadata.get('capabilities', {}).get('canDownload') is False:
            raise AppError('이 파일은 다운로드할 수 없어요. 소유자에게 권한을 확인해 주세요.', 403)
        size = metadata.get('size')
        if size is not None:
            try:
                size = int(size)
            except (ValueError, TypeError) as error:
                raise AppError('Google Drive 파일 용량을 확인할 수 없어요.', 502) from error
            if not 0 <= size <= MAX_BYTES:
                raise AppError('자료는 4MB 이하로 가져와 주세요.')
        elif mime != DOC_MIME:
            raise AppError('Google Drive 파일 용량을 확인할 수 없어요.', 502)
        if mime == DOC_MIME:
            data = await self._download(url + '/export', token, {'mimeType': 'text/plain'})
            mime = 'text/plain'
        else:
            data = await self._download(url, token, {'alt': 'media'})
        normalized = await read_input({'kind': 'image' if mime.startswith('image/') else 'file',
                                       'title': metadata.get('name'), 'name': metadata.get('name'),
                                       'mime': mime, 'data': base64.b64encode(data).decode()})
        link = _safe_link(metadata.get('webViewLink'), {'drive.google.com', 'docs.google.com'})
        return {**normalized, 'driveFileId': file_id,
                'url': link or 'https://drive.google.com/file/d/' + file_id + '/view'}
