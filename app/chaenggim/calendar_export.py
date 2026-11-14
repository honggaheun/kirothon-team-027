"""RFC5545 ICS export of approved internal events. Pure: no DB/auth/network/clock."""
from datetime import datetime, timezone

DOMAIN = 'ai-hackathon.cloud'
EPOCH = '19700101T000000Z'


def _parse(value):
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    except ValueError:
        return None
    return dt.astimezone(timezone.utc) if dt.tzinfo and dt.utcoffset() is not None else None


def _fmt(dt):
    return dt.strftime('%Y%m%dT%H%M%SZ')


def _text(value):
    s = '' if value is None else str(value)
    s = s.replace('\r\n', '\n').replace('\r', '\n')
    return (s.replace('\\', '\\\\').replace(';', '\\;')
             .replace(',', '\\,').replace('\n', '\\n'))


def _fold(line):
    out, cur, size, limit = [], '', 0, 75
    for ch in line:
        n = len(ch.encode('utf-8'))
        if size + n > limit:
            out.append(cur)
            cur, size, limit = ' ', 1, 75
        cur += ch
        size += n
    out.append(cur)
    return out


def export_calendar(items):
    lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ai-hackathon.cloud//chaenggim//KO',
             'CALSCALE:GREGORIAN', 'X-WR-CALNAME:LERO']
    for it in items or []:
        if not isinstance(it, dict) or it.get('approved') is not True or it.get('kind') != 'event':
            continue
        start, end = _parse(it.get('start')), _parse(it.get('end'))
        if not start or not end or end <= start or not it.get('id'):
            continue
        stamp = _parse(it.get('updatedAt')) or _parse(it.get('createdAt'))
        lines += [
            'BEGIN:VEVENT',
            f"UID:{_text(it['id'])}@{DOMAIN}",
            f"DTSTAMP:{_fmt(stamp) if stamp else EPOCH}",
            f'DTSTART:{_fmt(start)}',
            f'DTEND:{_fmt(end)}',
            f"SUMMARY:{_text(it.get('title'))}",
            f"DESCRIPTION:{_text(it.get('evidence'))}",
            'END:VEVENT',
        ]
    lines.append('END:VCALENDAR')
    return ''.join(p + '\r\n' for l in lines for p in _fold(l))
