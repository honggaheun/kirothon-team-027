"""Bounded, read-only listing of the user's primary and LERO calendars."""
import re
from datetime import date, datetime, time, timedelta
from urllib.parse import quote, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from .domain import AppError
from .rules import KST


BASE = 'https://www.googleapis.com/calendar/v3/calendars/'
FIELDS = 'nextPageToken,items(id,status,summary,start,end,htmlLink)'


def _safe_link(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(char) < 32 for char in value):
        return None
    try:
        parsed = urlparse(value)
        if (parsed.scheme == 'https' and parsed.hostname in ('calendar.google.com', 'www.google.com')
                and parsed.port in (None, 443) and not parsed.username and not parsed.password
                and (parsed.path == '/calendar' or parsed.path.startswith('/calendar/'))):
            return value
    except ValueError:
        pass
    return None


def _event_time(value):
    try:
        if not isinstance(value, dict):
            raise ValueError()
        if 'date' in value and 'dateTime' not in value:
            raw = value['date']
            if not isinstance(raw, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', raw):
                raise ValueError()
            day = date.fromisoformat(raw)
            return raw, datetime.combine(day, time.min, KST), True
        if 'dateTime' in value and 'date' not in value:
            raw = value['dateTime']
            if not isinstance(raw, str) or not re.fullmatch(
                    r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?', raw):
                raise ValueError()
            parsed = datetime.fromisoformat(raw.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                zone = value.get('timeZone')
                if not isinstance(zone, str) or not zone:
                    raise ValueError()
                parsed = parsed.replace(tzinfo=KST if zone == 'Asia/Seoul' else ZoneInfo(zone))
            parsed = parsed.astimezone(KST)
            return parsed.isoformat(), parsed, False
        raise ValueError()
    except (ValueError, TypeError, OverflowError, ZoneInfoNotFoundError) as error:
        raise AppError('캘린더 일정의 날짜를 읽을 수 없어요. Google Calendar에서 날짜를 확인해 주세요.', 502) from error


def _event(value, calendar):
    if not isinstance(value, dict):
        raise AppError('캘린더 일정 응답을 확인할 수 없어요.', 502)
    if value.get('status') == 'cancelled':
        return None
    identifier = value.get('id')
    if (not isinstance(identifier, str) or not identifier or len(identifier) > 1024
            or any(ord(char) < 32 for char in identifier)):
        raise AppError('캘린더 일정 식별자를 확인할 수 없어요.', 502)
    start, at, all_day = _event_time(value.get('start'))
    end, until, end_all_day = _event_time(value.get('end'))
    if all_day != end_all_day or until < at or all_day and until == at:
        raise AppError('캘린더 일정의 시작·종료 날짜를 확인해 주세요.', 502)
    title = value.get('summary')
    title = title.strip()[:300] if isinstance(title, str) and title.strip() else '제목 없는 일정'
    result = {'id': identifier, 'title': title, 'start': start, 'end': end,
              'allDay': all_day, 'calendar': calendar}
    link = _safe_link(value.get('htmlLink'))
    if link:
        result['htmlLink'] = link
    return result, at, until


class GoogleCalendarRead:
    def __init__(self, store, oauth, client, clock=None):
        self.store, self.oauth, self.client = store, oauth, client
        self.clock = clock or (lambda: datetime.now(KST))

    def _bounds(self, period):
        days = {'today': 1, 'tomorrow': 1, 'week': 7, 'month': 30}
        if not isinstance(period, str) or period not in days:
            raise AppError('조회 기간은 오늘·내일·앞으로 7일·앞으로 30일 중에서 선택해 주세요.')
        current = self.clock()
        if not isinstance(current, datetime) or current.tzinfo is None:
            raise AppError('현재 시각을 확인할 수 없어요. 잠시 후 다시 조회해 주세요.', 503)
        start = current.astimezone(KST).replace(hour=0, minute=0, second=0, microsecond=0)
        if period == 'tomorrow':
            start += timedelta(days=1)
        return start, start + timedelta(days=days[period])

    async def _page(self, token, calendar, params):
        try:
            response = await self.client.get(BASE + quote(calendar, safe='') + '/events',
                                             headers={'Authorization': 'Bearer ' + token},
                                             params=params, timeout=10, follow_redirects=False)
        except httpx.RequestError as error:
            raise AppError('캘린더 응답을 확인하지 못했어요. 잠시 후 다시 조회해 주세요.', 502) from error
        if response.status_code in (401, 403):
            raise AppError('캘린더 읽기 권한을 확인할 수 없어요. 캘린더를 다시 연결해 주세요.', response.status_code)
        if response.status_code == 429:
            raise AppError('캘린더 요청이 많아요. 잠시 후 다시 조회해 주세요.', 503)
        if response.status_code == 404:
            raise AppError('캘린더를 찾을 수 없어요. 연결 상태를 확인해 주세요.', 404)
        if response.status_code != 200:
            raise AppError('캘린더 일정을 가져오지 못했어요. 잠시 후 다시 조회해 주세요.', 502)
        try:
            result = response.json()
            if not isinstance(result, dict) or not isinstance(result.get('items', []), list):
                raise ValueError()
            cursor = result.get('nextPageToken')
            if cursor is not None and (not isinstance(cursor, str) or not cursor or len(cursor) > 2048
                                       or any(ord(char) < 32 for char in cursor)):
                raise ValueError()
            return result
        except (ValueError, TypeError) as error:
            raise AppError('캘린더 일정 응답을 읽을 수 없어요. 잠시 후 다시 조회해 주세요.', 502) from error

    async def list_events(self, user, period='week', query=''):
        start, end = self._bounds(period)
        if not isinstance(query, str) or len(query) > 200 or any(ord(char) < 32 for char in query):
            raise AppError('캘린더 검색어를 200자 이내로 입력해 주세요.')
        calendars = ['primary']
        integration = self.store.get('calendar', user, user)
        if integration and integration.get('status') == 'ready':
            calendar = integration.get('calendarId')
            if (not isinstance(calendar, str) or not calendar or len(calendar) > 1024
                    or any(ord(char) < 32 for char in calendar)):
                raise AppError('앱 캘린더 연결 상태를 다시 확인해 주세요.', 409)
            if calendar not in calendars:
                calendars.append(calendar)
        token = await self.oauth.access_token(user, 'calendar_read')
        params = {'singleEvents': 'true', 'orderBy': 'startTime', 'timeMin': start.isoformat(),
                  'timeMax': end.isoformat(), 'timeZone': 'Asia/Seoul', 'maxResults': 50,
                  'fields': FIELDS}
        if query:
            params['q'] = query
        combined, truncated = [], False
        for calendar in calendars:
            page_token, found = None, {}
            for page_index in range(2):
                page = await self._page(token, calendar, {**params, **({'pageToken': page_token} if page_token else {})})
                rows = page.get('items', [])
                if len(rows) > 50:
                    truncated = True
                for raw in rows[:50]:
                    parsed = _event(raw, calendar)
                    if parsed is None:
                        continue
                    item, at, until = parsed
                    if at < end and until > start:
                        found.setdefault(item['id'], (at, calendar, item['id'], item))
                next_page = page.get('nextPageToken')
                if len(found) >= 50:
                    truncated = truncated or len(found) > 50 or bool(next_page)
                    break
                if not next_page:
                    break
                if page_index == 1 or next_page == page_token:
                    truncated = True
                    break
                page_token = next_page
            combined.extend(sorted(found.values(), key=lambda value: value[:3])[:50])
        combined.sort(key=lambda value: value[:3])
        return {'items': [value[3] for value in combined[:50]], 'period': period,
                'truncated': truncated or len(combined) > 50}
