"""외부 상태를 읽지 않는 실행 전 판정. 현재 시각/계정 사실은 서버가 공급한다."""
import re
from datetime import datetime, timezone, timedelta

RULES = {'R1.1':'본인의 자료와 일정만 변경할 수 있어요.','R2.1':'계획을 먼저 확인하고 승인해 주세요.','R3.1':'계획이 변경됐어요. 새로고침 후 다시 확인해 주세요.','R4.1':'같은 일정이 이미 등록되어 있어요.','R5.1':'일정의 날짜와 종료 시각을 확인해 주세요.','R6.1':'알림은 마감 전에 설정해 주세요.','R7.1':'알림은 항목마다 3개까지 설정할 수 있어요.','R8.1':'알림은 오전 8시부터 오후 10시 전까지 설정해 주세요.'}
KST=timezone(timedelta(hours=9))
def timestamp(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})',value):
        return None
    try: return datetime.fromisoformat(value.replace('Z','+00:00'))
    except ValueError: return None

def check(data):
    def no(reason): return {'ok':False,'reason':reason}
    if not data.get('userId') or data.get('userId')!=data.get('ownerId'): return no('R1.1')
    if data.get('approved') is not True: return no('R2.1')
    if data.get('version')!=data.get('expectedVersion'): return no('R3.1')
    if data.get('duplicate'): return no('R4.1')
    items=data.get('items')
    if not isinstance(items,list) or not 1<=len(items)<=40: return no('R5.1')
    for item in items:
        if not isinstance(item,dict) or not isinstance(item.get('title'),str) or not item['title'].strip() or len(item['title'])>160 or item.get('kind') not in ('event','task'): return no('R5.1')
        start,end=timestamp(item.get('start')),timestamp(item.get('end'))
        if (item['kind']=='event' and not start) or (item.get('start') and not start) or (item.get('end') and (not end or not start or end<=start)): return no('R5.1')  # [notice-execution:R1.1]
        reminders=item.get('reminders',[])
        if not isinstance(reminders,list) or len(reminders)>3: return no('R7.1')
        for reminder in reminders:
            at=timestamp(reminder)
            if not at or not start or at>=start: return no('R6.1')
            if not 8<=at.astimezone(KST).hour<22: return no('R8.1')  # [notice-execution:R2.1]
    return {'ok':True}
