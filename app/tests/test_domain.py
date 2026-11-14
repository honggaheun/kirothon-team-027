import importlib
import pytest

def module(name):
    try:
        return importlib.import_module('chaenggim.' + name)
    except ModuleNotFoundError:
        return None

def item(**changes):
    return {'title': '소풍', 'kind': 'event', 'start': '2026-11-21T09:00:00+09:00', 'end': '2026-11-21T10:00:00+09:00', 'origin': 'source', 'evidence': '소풍', 'reminders': [], **changes}

def valid(**changes):
    return {'userId':'u', 'ownerId':'u', 'approved':True, 'version':1, 'expectedVersion':1, 'duplicate':False, 'items':[item()], **changes}

def test_authorization_approval_version_duplicates():
    rules = module('rules'); assert rules is not None
    assert rules.check(valid()) == {'ok':True}
    for change, reason in [({'ownerId':'other'},'R1.1'),({'approved':False},'R2.1'),({'expectedVersion':2},'R3.1'),({'duplicate':True},'R4.1')]:
        assert rules.check(valid(**change))['reason'] == reason

@pytest.mark.parametrize('start,end', [(None,None),('garbage',None),('2026-02-30T09:00:00+09:00',None),('2026-11-21T09:00:00+09:00','2026-11-20T09:00:00+09:00')])
def test_invalid_dates_fail(start,end):
    rules=module('rules'); assert rules is not None
    assert rules.check(valid(items=[item(start=start,end=end)]))['ok'] is False

@pytest.mark.parametrize('clock,allowed',[('21:59',True),('22:00',False),('07:59',False),('08:00',True)])
def test_quiet_hour_boundaries(clock,allowed):
    rules=module('rules'); assert rules is not None
    assert rules.check(valid(items=[item(reminders=[f'2026-11-20T{clock}:00+09:00'])]))['ok'] is allowed

def test_reminder_maximum_and_deadline():
    rules=module('rules'); assert rules is not None
    assert rules.check(valid(items=[item(reminders=['2026-11-20T12:00:00+09:00']*4)]))['reason']=='R7.1'
    assert rules.check(valid(items=[item(reminders=['2026-11-21T10:00:00+09:00'])]))['reason']=='R6.1'

def test_approval_atomic_idempotent_durable_scoped(tmp_path):
    storage=module('store'); domain=module('domain'); assert storage and domain
    path=tmp_path/'app.sqlite'; store=storage.Store(path); service=domain.Plans(store)
    source=service.add_source('u',{'kind':'text','title':'소풍','text':'소풍 11월21일9시'})
    proposal={'title':'소풍','summary':'소풍 안내','questions':[],'items':[item()]}
    draft=service.propose('u',source['id'],proposal)
    assert store.list('items','u')==[]
    with pytest.raises(domain.AppError): service.approve('other',draft['id'],1)
    result=service.approve('u',draft['id'],1); service.approve('u',draft['id'],1)
    assert len(store.list('items','u'))==1
    existing=result['items'][0]
    changed=service.propose('u',source['id'],{**proposal,'items':[item(start='2026-11-21T10:00:00+09:00',end='2026-11-21T11:00:00+09:00',replacesId=existing['id'])]})
    service.approve('u',changed['id'],1)
    assert len(store.list('items','u'))==1
    store.close();store=storage.Store(path)
    assert store.get('items',existing['id'],'u')['start']=='2026-11-21T10:00:00+09:00'
    store.close()

def test_source_changes_invalidate_old_draft_and_evidence_is_immutable():
    storage=module('store'); domain=module('domain'); assert storage and domain
    store=storage.Store(':memory:'); service=domain.Plans(store)
    source=service.add_source('u',{'kind':'text','text':'소풍'})
    draft=service.propose('u',source['id'],{'title':'소풍','summary':'안내','questions':[],'items':[item()]})
    with pytest.raises(domain.AppError):service.edit('u',draft['id'],1,[{**draft['items'][0],'evidence':'위조'}])
    store.put('sources',{**source,'version':2})
    with pytest.raises(domain.AppError):service.approve('u',draft['id'],1)
    store.close()
