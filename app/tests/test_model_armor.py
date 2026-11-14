import base64
import copy
import importlib
import json

import httpx
import pytest

from chaenggim.domain import AppError


TEMPLATE = 'projects/test-project/locations/us/templates/lero-input-guard'
ALLOWED = {'sanitizationResult': {
    'invocationResult': 'SUCCESS', 'filterMatchState': 'NO_MATCH_FOUND',
    'filterResults': {'pi_and_jailbreak': {'piAndJailbreakFilterResult': {
        'executionState': 'EXECUTION_SUCCESS', 'matchState': 'NO_MATCH_FOUND'}}}}}


def armor(client, template=TEMPLATE, provider=None):
    async def token():
        return 'private-access-token'
    module = importlib.import_module('chaenggim.model_armor')
    return module.ModelArmor(client, template, provider or token)


async def test_korean_latest_text_requests_multilingual_inspection_without_mutation():
    requests = []
    async def handler(request):
        requests.append(request)
        return httpx.Response(200, json=ALLOWED)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await armor(client).check_text('내 일정 알려줘') is None
    request = requests[0]
    assert request.method == 'POST'
    assert str(request.url) == 'https://modelarmor.us.rep.googleapis.com/v1/' + TEMPLATE + ':sanitizeUserPrompt'
    assert request.headers['authorization'] == 'Bearer private-access-token'
    assert json.loads(request.content) == {
        'userPromptData': {'text': '내 일정 알려줘'},
        'multiLanguageDetectionMetadata': {'enableMultiLanguageDetection': True}}


async def test_detected_injection_blocks_without_echoing_source_or_token(caplog):
    result = copy.deepcopy(ALLOWED)
    result['sanitizationResult']['filterMatchState'] = 'MATCH_FOUND'
    result['sanitizationResult']['filterResults']['pi_and_jailbreak']['piAndJailbreakFilterResult']['matchState'] = 'MATCH_FOUND'
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=result))) as client:
        with pytest.raises(AppError) as error:
            await armor(client).check_text('secret source payload')
    assert error.value.status == 400
    assert 'secret source payload' not in str(error.value) + caplog.text
    assert 'private-access-token' not in str(error.value) + caplog.text


@pytest.mark.parametrize('change', [
    {'invocationResult': 'PARTIAL'}, {'invocationResult': 'FAILURE'},
    {'invocationResult': None}, {'invocationResult': 'NEW_UNKNOWN_STATE'},
    {'filterResults': {}}, {'filterResults': []}, {'filterMatchState': None},
])
async def test_incomplete_response_is_never_accepted(change):
    result = copy.deepcopy(ALLOWED)
    result['sanitizationResult'].update(change)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=result))) as client:
        with pytest.raises(AppError) as error:
            await armor(client).check_text('공지')
    assert error.value.status == 503


@pytest.mark.parametrize('change', [
    {'executionState': 'EXECUTION_SKIPPED'}, {'executionState': 'EXECUTION_FAILED'},
    {'executionState': None}, {'matchState': None}, {'matchState': 'UNKNOWN'},
    {'messageItems': [{'messageType': 'WARNING', 'message': 'uninspected content'}]},
    {'messageItems': 'malformed'},
])
async def test_missing_or_uninspected_pij_result_fails_closed(change):
    result = copy.deepcopy(ALLOWED)
    result['sanitizationResult']['filterResults']['pi_and_jailbreak']['piAndJailbreakFilterResult'].update(change)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=result))) as client:
        with pytest.raises(AppError) as error:
            await armor(client).check_text('공지')
    assert error.value.status == 503


@pytest.mark.parametrize('status', [301, 401, 403, 429, 500, 503])
async def test_http_failure_is_closed_without_following_redirect_or_echoing_response(status):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, text='private-access-token secret source payload',
                              headers={'Location': 'https://attacker.example'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
        with pytest.raises(AppError) as error:
            await armor(client).check_text('공지')
    assert error.value.status == 503
    assert len(calls) == 1
    assert 'secret' not in str(error.value)


@pytest.mark.parametrize('failure', ['timeout', 'json', 'missing', 'list', 'token'])
async def test_transport_auth_and_malformed_failures_do_not_pass(failure):
    async def provider():
        if failure == 'token':raise RuntimeError('private-access-token')
        return 'private-access-token'
    def handler(request):
        if failure == 'timeout':raise httpx.ReadTimeout('private-access-token')
        if failure == 'json':return httpx.Response(200, text='not JSON private-access-token')
        if failure == 'list':return httpx.Response(200, json=[])
        return httpx.Response(200, json={})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AppError) as error:
            await armor(client, provider=provider).check_text('공지')
    assert error.value.status == 503
    assert 'private-access-token' not in str(error.value)


@pytest.mark.parametrize('template', ['', None, 'https://evil.example',
    'projects/p/locations/us.evil/templates/t', 'projects/p/locations/us/templates/../other',
    'projects/p/locations/us/templates/t?key=secret'])
def test_missing_or_untrusted_template_rejected(template):
    with pytest.raises(AppError) as error:
        armor(None, template)
    assert error.value.status == 503


@pytest.mark.parametrize('mime,raw,kind', [
    ('application/pdf', b'%PDF-1.7\nnotice', 'PDF'),
    ('image/png', b'\x89PNG\r\n\x1a\nnotice', 'IMAGE'),
    ('image/jpeg', b'\xff\xd8\xffnotice', 'IMAGE'),
])
async def test_attachment_bytes_and_source_text_both_screened(mime, raw, kind):
    requests = []
    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=ALLOWED)
    source = {'title': '자료 제목', 'text': '공지 내용', 'mime': mime,
              'data': base64.b64encode(raw).decode()}
    original = copy.deepcopy(source)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await armor(client).check_source(source)
    assert source == original
    assert len(requests) == 2
    assert '자료 제목' in requests[0]['userPromptData']['text']
    assert '공지 내용' in requests[0]['userPromptData']['text']
    assert requests[1]['userPromptData'] == {'byteItem': {'byteDataType': kind, 'byteData': source['data']}}
    assert all(request['multiLanguageDetectionMetadata']['enableMultiLanguageDetection'] for request in requests)


@pytest.mark.parametrize('source', [
    {'mime': 'application/pdf', 'data': 'not base64!'},
    {'mime': 'application/pdf', 'data': base64.b64encode(b'not pdf').decode()},
    {'mime': 'application/zip', 'data': base64.b64encode(b'zip').decode()},
    {'mime': 'image/png', 'data': base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'x' * (4 * 1024 * 1024)).decode()},
    {'text': '한' * (512 * 1024)}, {'title': []},
])
async def test_invalid_or_oversize_input_rejected_before_any_network(source):
    calls = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: calls.append(r))) as client:
        with pytest.raises(AppError) as error:
            await armor(client).check_source(source)
    assert error.value.status in (400, 413)
    assert calls == []


@pytest.mark.parametrize('source', [
    {'title': 'file', '_blob': 'private/object'},
    {'title': 'file', 'kind': 'image'},
    {'title': 'file', 'mime': 'application/pdf'},
])
async def test_stored_file_cannot_pass_by_screening_only_its_label(source):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200,json=ALLOWED))) as client:
        with pytest.raises(AppError) as error:
            await armor(client).check_source(source)
    assert error.value.status == 503


async def test_empty_text_and_source_need_no_inspection_request():
    calls = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: calls.append(r))) as client:
        checker = armor(client)
        assert await checker.check_text('  ') is None
        assert await checker.check_source({}) is None
    assert calls == []
