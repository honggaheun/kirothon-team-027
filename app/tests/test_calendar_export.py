from chaenggim.calendar_export import export_calendar


def ev(**kw):
    base = {'id': 'e1', 'kind': 'event', 'approved': True, 'title': '발표',
            'evidence': '근거', 'start': '2026-11-21T10:00:00+09:00',
            'end': '2026-11-21T11:00:00+09:00'}
    base.update(kw)
    return base


def unfold(text):
    return text.replace('\r\n ', '')


def test_empty_output_has_calendar_frame():
    out = export_calendar([])
    lines = out.split('\r\n')
    assert lines[0] == 'BEGIN:VCALENDAR'
    assert 'VERSION:2.0' in lines
    assert any(l.startswith('PRODID:') for l in lines)
    assert 'CALSCALE:GREGORIAN' in lines
    assert 'END:VCALENDAR' in lines
    assert 'BEGIN:VEVENT' not in out


def test_only_approved_timed_events_exported():
    items = [
        ev(id='ok'),
        ev(id='task', kind='task'),
        ev(id='unapproved', approved=False),
        ev(id='nostart', start=None),
        ev(id='noend', end=None),
        ev(id='badstart', start='not-a-date'),
        ev(id='nooffset', start='2026-11-21T10:00:00'),
        ev(id='reversed', start='2026-11-21T11:00:00+09:00', end='2026-11-21T10:00:00+09:00'),
        ev(id='equal', end='2026-11-21T10:00:00+09:00'),
    ]
    out = export_calendar(items)
    assert out.count('BEGIN:VEVENT') == 1
    assert 'UID:ok@ai-hackathon.cloud' in out


def test_kst_converted_to_utc():
    out = export_calendar([ev()])
    assert 'DTSTART:20261121T010000Z' in out
    assert 'DTEND:20261121T020000Z' in out
    assert 'SUMMARY:발표' in out
    assert 'DESCRIPTION:근거' in out


def test_dtstamp_rules():
    assert 'DTSTAMP:19700101T000000Z' in export_calendar([ev()])
    assert 'DTSTAMP:20261101T000000Z' in export_calendar([ev(createdAt='2026-11-01T09:00:00+09:00')])
    out = export_calendar([ev(createdAt='2026-11-01T09:00:00+09:00', updatedAt='2026-11-02T09:00:00+09:00')])
    assert 'DTSTAMP:20261102T000000Z' in out


def test_crlf_cannot_inject_properties():
    out = export_calendar([ev(title='a\r\nATTENDEE:mailto:x@y.z', evidence='b\nEND:VEVENT\r\nBEGIN:VEVENT')])
    lines = out.split('\r\n')
    assert not any(l.startswith('ATTENDEE') for l in lines)
    assert lines.count('BEGIN:VEVENT') == 1
    assert lines.count('END:VEVENT') == 1
    assert 'SUMMARY:a\\nATTENDEE:mailto:x@y.z' in unfold(out)


def test_text_escaping():
    out = unfold(export_calendar([ev(title='a,b;c\\d')]))
    assert 'SUMMARY:a\\,b\\;c\\\\d' in out


def test_long_korean_folding_roundtrip():
    ev_text = '가나다라마바사' * 40
    out = export_calendar([ev(evidence=ev_text)])
    raw = out.encode('utf-8')
    for phys in raw.split(b'\r\n'):
        assert len(phys) <= 75
    assert out.endswith('\r\n')
    assert 'DESCRIPTION:' + ev_text in unfold(out)
    out.encode('utf-8').decode('utf-8')


def test_deterministic():
    items = [ev(id='a'), ev(id='b', start='2026-11-22T10:00:00+09:00', end='2026-11-22T11:00:00+09:00')]
    assert export_calendar(items) == export_calendar(items)


def test_calendar_name():
    assert 'X-WR-CALNAME:LERO' in export_calendar([])
