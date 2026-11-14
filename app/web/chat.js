let context;
let owner = null;
let epoch = 0;
let cache = {messages: [], pendingDraftId: null};
let loaded = false;
let loading;
let loadError = '';
let busy = false;
let pendingSend = null;
let registered = false;
let revision = 0;
let blockedOwner = null;
let inputs = {chat: '', quick: ''};
let attachments = {chat: null, quick: null};
let reading = {chat: false, quick: false};
let accountEpoch = 0;
let conversations = [];
let activeConversationId = null;
let conversationsLoaded = false;
let conversationsLoading = null;
let conversationBusy = false;

const prompts = ['오늘 할 일 보여줘', '내일 발표 준비 계획을 세워줘', 'Gmail 공지 가져와줘', 'Drive 파일 찾아줘'];
const allowedMimes = ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'];
const fallbackMimes = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', txt: 'text/plain'};
const MAX_FILE = 4 * 1024 * 1024;

function esc(value) { return context.esc(String(value ?? '')); }
function glyph(name) {
  const paths = {
    send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    clip: '<path d="m9 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8"/>',
    chat: '<path d="M5 18 3 21v-6a8 8 0 1 1 4 4Z"/><path d="M8 10h8m-8 4h5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  };
  return paths[name] ? `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>` : context.icon(name);
}
function assistantImage() { return '<img src="/kiro-icon.png" alt="" aria-hidden="true">'; }

function reset(nextOwner) {
  owner = nextOwner;
  accountEpoch += 1;
  conversations = [];
  conversationsLoaded = false;
  conversationsLoading = null;
  conversationBusy = false;
  activeConversationId = storedConversation(nextOwner);
  resetConversationState();
}

function storedConversation(user) {
  if (!user) return null;
  try { return localStorage.getItem(`lero:active-conversation:${encodeURIComponent(user)}`) || null; }
  catch { return null; }
}

function rememberConversation() {
  if (!owner) return;
  try {
    const key = `lero:active-conversation:${encodeURIComponent(owner)}`;
    if (activeConversationId) localStorage.setItem(key, activeConversationId);
    else localStorage.removeItem(key);
  } catch { /* Conversation selection still works when storage is unavailable. */ }
}

function resetConversationState() {
  epoch += 1;
  revision += 1;
  cache = {messages: [], pendingDraftId: null};
  loaded = false;
  loading = null;
  loadError = '';
  busy = false;
  pendingSend = null;
  inputs = {chat: '', quick: ''};
  attachments = {chat: null, quick: null};
  reading = {chat: false, quick: false};
}

function activateConversation(id) {
  if (id === activeConversationId) return;
  activeConversationId = id;
  resetConversationState();
  rememberConversation();
}

function currentOwner() {
  const actual = context?.getState()?.me?.user?.id ?? null;
  if (blockedOwner && actual !== blockedOwner) blockedOwner = null;
  const nextOwner = actual === blockedOwner ? null : actual;
  if (nextOwner !== owner) reset(nextOwner);
  return owner;
}

function sameAccount(ticket) { return currentOwner() === ticket.owner && accountEpoch === ticket.accountEpoch; }
function requestTicket() { return {owner, epoch, accountEpoch, conversationId: activeConversationId}; }
function current(ticket) { return sameAccount(ticket) && epoch === ticket.epoch && activeConversationId === ticket.conversationId; }
function normalize(result) {
  return {messages: Array.isArray(result?.messages) ? result.messages.slice(-24) : [],
    pendingDraftId: typeof result?.pendingDraftId === 'string' ? result.pendingDraftId : null};
}

export function configureChat(value) {
  context = value;
  currentOwner();
  if (registered) return;
  registered = true;
  document.addEventListener('submit', handleSubmit);
  document.addEventListener('click', handleClick);
  document.addEventListener('input', handleInput);
  document.addEventListener('change', handleFile);
  document.addEventListener('keydown', handleKeydown);
  const root = document.querySelector('#app');
  if (root && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => currentOwner()).observe(root, {childList: true});
  }
}

async function loadConversations(force = false) {
  const user = currentOwner();
  if (!user || conversationsLoaded && !force) return conversations;
  if (conversationsLoading) return conversationsLoading;
  const ticket = requestTicket();
  const request = (async () => {
    try {
      const result = await context.api('/api/chat/threads');
      if (sameAccount(ticket)) {
        conversations = (Array.isArray(result?.threads) ? result.threads : []).filter(value => typeof value?.id === 'string');
        conversationsLoaded = true;
        if (!conversations.some(value => value.id === activeConversationId)) activateConversation(conversations[0]?.id ?? null);
      }
      return conversations;
    } finally { if (sameAccount(ticket) && conversationsLoading === request) conversationsLoading = null; }
  })();
  conversationsLoading = request;
  return request;
}

async function createConversation() {
  const ticket = requestTicket();
  const result = await context.api('/api/chat/threads', {method: 'POST', body: {}});
  if (!sameAccount(ticket)) return null;
  if (typeof result?.id !== 'string') throw new Error('새 대화를 만들지 못했어요. 다시 시도해 주세요.');
  conversations = [result, ...conversations.filter(value => value.id !== result.id)];
  conversationsLoaded = true;
  activateConversation(result.id);
  return result.id;
}

export async function loadChat() {
  const user = currentOwner();
  if (!user || loaded || busy || conversationBusy) return cache;
  const accountTicket = {owner: user, accountEpoch};
  try { await loadConversations(); }
  catch (error) { loadError = error.message || '대화 목록을 불러오지 못했어요.'; return cache; }
  if (!sameAccount(accountTicket)) return cache;
  if (!activeConversationId) { loaded = true; return cache; }
  if (loading) return loading;
  const ticket = {...requestTicket(), revision};
  const request = (async () => {
    try {
      const result = await context.api('/api/chat?' + new URLSearchParams({conversationId: ticket.conversationId}));
      if (current(ticket) && revision === ticket.revision) {
        cache = normalize(result);
        loaded = true;
        loadError = '';
      }
    } catch (error) {
      if (current(ticket) && error.status === 404) {
        try {
          await loadConversations(true);
          if (sameAccount(ticket) && ticket.conversationId !== activeConversationId) return loadChat();
        } catch { /* Keep the original error when the server is unavailable. */ }
      }
      if (current(ticket)) {
        loadError = error.message || '대화를 불러오지 못했어요.';
        context.toast(loadError);
      }
    } finally {
      if (current(ticket) && loading === request) loading = null;
    }
    return cache;
  })();
  loading = request;
  return request;
}

async function renderUI() {
  try { await context.render(); }
  catch (error) { context.toast(error.message || '화면을 다시 불러와 주세요.'); }
  scrollBottom();
}

function scrollBottom() {
  requestAnimationFrame(() => {
    const thread = document.querySelector('#chat-thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
    for (const scope of ['chat', 'quick']) resize(document.querySelector(`[data-chat-input="${scope}"]`));
  });
}

function resize(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 62), 190)}px`;
}

function focusInput(scope) {
  requestAnimationFrame(() => {
    const input = document.querySelector(`[data-chat-input="${scope}"]`);
    input?.focus({preventScroll: true});
    resize(input);
  });
}

function draft(id) { return context.getState()?.data?.drafts?.find(value => value.id === id); }
function draftHref(id) { return '#draft/' + encodeURIComponent(id); }
function canApprove(id) {
  const value = draft(id);
  return !!value && value.status === 'draft' && cache.pendingDraftId === id
    && !(value.items || []).some(item => item.kind === 'event' && !item.start);
}

function approveButton(id, label = '확인한 계획 등록') {
  const value = draft(id);
  const available = canApprove(id);
  const text = value?.status === 'approved' ? '이미 등록한 계획' : cache.pendingDraftId !== id ? '이전 초안'
    : !available ? '날짜를 먼저 확인해 주세요' : label;
  return `<button type="button" class="chat-primary" data-chat-action="approve" data-draft-id="${esc(id)}" ${!available || busy ? 'disabled' : ''}>${glyph('check')}${esc(text)}</button>`;
}

function shortDate(value) {
  if (!value) return '날짜 미정';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '날짜 확인 필요' : date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit'});
}

function draftCard(id, sidebar = false) {
  const value = draft(id);
  if (!value) return `<a class="chat-missing-draft" href="${esc(draftHref(id))}">${glyph('file')}계획 내용 확인${glyph('arrow')}</a>`;
  const latest = cache.pendingDraftId === id && value.status === 'draft';
  const questions = Array.isArray(value.questions) ? value.questions : [];
  const items = Array.isArray(value.items) ? value.items : [];
  return `<section class="chat-draft-card ${latest ? 'is-current' : ''} ${sidebar ? 'is-sidebar' : ''}" aria-label="${esc(value.title)} 계획 초안">
    <div class="chat-card-kicker">${glyph('file')}<span>${value.status === 'approved' ? '등록한 계획' : latest ? '확인할 계획' : '이전 계획 초안'}</span><span class="chat-card-count">${items.length}개 항목</span></div>
    <h3>${esc(value.title)}</h3>${value.summary ? `<p class="chat-draft-summary">${esc(value.summary.slice(0, sidebar ? 260 : 420))}</p>` : ''}
    ${sidebar && items.length ? `<ul class="chat-plan-items">${items.slice(0, 3).map(item => `<li><span>${glyph(item.kind === 'event' ? 'calendar' : 'check')}</span><div><strong>${esc(item.title)}</strong><small>${esc(shortDate(item.start))}</small></div></li>`).join('')}${items.length > 3 ? `<li class="chat-more-items">외 ${items.length - 3}개 항목</li>` : ''}</ul>` : ''}
    ${questions.length ? `<div class="chat-questions"><strong>먼저 확인해 주세요</strong><ul>${questions.slice(0, 3).map(question => `<li>${esc(question)}</li>`).join('')}</ul>${questions.length > 3 ? `<span>확인할 내용 ${questions.length - 3}개 더 있어요.</span>` : ''}</div>` : ''}
    <a class="chat-review-link" href="${esc(draftHref(id))}">계획 자세히 확인${glyph('arrow')}</a>
    ${sidebar ? approveButton(id) : ''}
  </section>`;
}

function connectHref(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin && !url.username && !url.password && !url.search && !url.hash
      && /^\/auth\/connect\/(calendar|calendar_read|gmail|tasks|drive)$/.test(url.pathname) ? url.pathname : null;
  } catch { return null; }
}

function messageActions(actions = []) {
  if (!Array.isArray(actions)) return '';
  const rendered = actions.slice(0, 8).map(action => {
    if (action?.kind === 'approve' && typeof action.draftId === 'string') return approveButton(action.draftId, String(action.label || '확인한 계획 등록').slice(0, 80));
    const href = action?.kind === 'connect' ? connectHref(action.href) : null;
    return href ? `<a class="chat-connect" href="${esc(href)}" data-chat-action="connect">${glyph('link')}${esc(String(action.label || '서비스 연결').slice(0, 80))}${glyph('arrow')}</a>` : '';
  }).join('');
  return rendered ? `<div class="chat-message-actions">${rendered}</div>` : '';
}

function fileSize(size) {
  const bytes = Number(size);
  return Number.isFinite(bytes) && bytes > 0 ? bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB` : '';
}

function filesView(files) {
  if (!Array.isArray(files)) return '';
  const rows = files.slice(0, 20).filter(file => typeof file?.id === 'string');
  return rows.length ? `<div class="chat-drive-files">${rows.map(file => `<div class="chat-drive-file"><span class="chat-file-icon">${glyph(file.mimeType?.startsWith('image/') ? 'image' : 'file')}</span><div><strong>${esc(file.name || '이름 없는 자료')}</strong><small>${esc([file.mimeType === 'application/pdf' ? 'PDF' : file.mimeType?.startsWith('image/') ? '이미지' : '문서', fileSize(file.size)].filter(Boolean).join(' · '))}</small></div><button type="button" class="chat-file-import" data-chat-action="drive-import" data-file-id="${esc(file.id)}" ${busy ? 'disabled' : ''}>가져오기${glyph('arrow')}</button></div>`).join('')}</div>` : '';
}

function sourceCitations(sources) {
  if (!Array.isArray(sources)) return '';
  const rows = sources.filter(value => typeof value?.id === 'string');
  return rows.length ? `<nav class="chat-answer-sources" aria-label="답변에 참고한 내 자료"><span>참고한 자료</span>${rows.map(value => `<a href="#source/${encodeURIComponent(value.id)}">${glyph('file')}${esc(value.title || '원문 자료 보기')}</a>`).join('')}</nav>` : '';
}

function messageView(message) {
  const isUser = message.role === 'user';
  return `<article class="chat-message ${isUser ? 'is-user' : 'is-assistant'}"><span class="chat-avatar" aria-hidden="true">${isUser ? '나' : assistantImage()}</span><div class="chat-message-body"><div class="chat-message-author">${isUser ? '나' : 'LERO'}</div><p class="chat-message-text">${esc(message.text)}</p>${!isUser ? sourceCitations(message.sources) : ''}${!isUser && typeof message.draftId === 'string' ? draftCard(message.draftId) : ''}${!isUser ? filesView(message.files) + messageActions(message.actions) : ''}</div></article>`;
}

function conversationControls() {
  const unavailable = busy || conversationBusy || reading.chat || reading.quick || !!conversationsLoading;
  const disabled = unavailable ? 'disabled' : '';
  const selected = conversations.find(value => value.id === activeConversationId);
  return `<section class="chat-conversations" aria-label="대화 관리"><div class="chat-conversations-head"><div><h2>내 대화</h2><p>대화마다 공지와 요청을 나눠서 챙겨요.</p></div><button type="button" class="chat-new-conversation" data-chat-action="new-conversation" ${disabled}>${glyph('plus')}새 대화</button></div><div class="chat-conversation-current"><label class="chat-sr-only" for="chat-conversation-select">현재 대화 선택</label><select id="chat-conversation-select" data-chat-conversation ${disabled || !conversations.length ? 'disabled' : ''}>${conversations.length ? conversations.map(value => `<option value="${esc(value.id)}" ${value.id === activeConversationId ? 'selected' : ''}>${esc(value.title || '새 대화')}</option>`).join('') : '<option value="">새 대화를 시작해 보세요</option>'}</select><button type="button" class="chat-delete-conversation" data-chat-action="delete-conversation" data-conversation-id="${esc(activeConversationId || '')}" aria-label="${esc(selected?.title || '현재 대화')} 대화 삭제" title="이 대화만 삭제하며 등록한 계획과 자료는 남아요." ${disabled || !activeConversationId ? 'disabled' : ''}>${glyph('trash')}<span>삭제</span></button></div>${conversations.length ? `<details class="chat-conversation-history"><summary>대화 목록 <span>${conversations.length}개</span></summary><div>${conversations.map(value => `<button type="button" data-chat-action="select-conversation" data-conversation-id="${esc(value.id)}" ${value.id === activeConversationId ? 'aria-current="true"' : ''} ${disabled}>${glyph('chat')}<span>${esc(value.title || '새 대화')}</span>${value.id === activeConversationId ? '<small>현재 대화</small>' : ''}</button>`).join('')}</div></details>` : ''}<p class="chat-conversation-note">대화를 삭제해도 등록한 계획과 자료는 남아요.</p></section>`;
}

function suggestedPrompts(scope, compact = false) {
  const values = compact ? [prompts[0], prompts[2], prompts[3]] : prompts;
  return `<div class="chat-prompts" aria-label="대화 요청 예시">${values.map((text, index) => `<button type="button" data-chat-action="prompt" data-chat-scope="${scope}" data-prompt="${esc(text)}" ${busy ? 'disabled' : ''}>${compact ? '' : glyph(['check', 'calendar', 'mail', 'folder'][index])}<span>${esc(text)}</span>${compact ? '' : glyph('arrow')}</button>`).join('')}</div>`;
}

function composer(scope) {
  const attachment = attachments[scope];
  const unavailable = busy || conversationBusy || reading[scope];
  return `<form id="${scope === 'chat' ? 'chat-form' : 'quick-chat-form'}" class="chat-composer" data-chat-scope="${scope}">
    ${reading[scope] ? '<div class="chat-attachment-reading" role="status">첨부 파일을 읽고 있어요.</div>' : attachment ? `<div class="chat-attachment">${glyph(attachment.source.mime.startsWith('image/') ? 'image' : 'file')}<span><strong>${esc(attachment.source.name)}</strong><small>${esc(fileSize(attachment.size))}</small></span><button type="button" data-chat-action="remove-file" data-chat-scope="${scope}" aria-label="첨부 파일 제거" ${busy ? 'disabled' : ''}>${glyph('close')}</button></div>` : ''}
    <label class="chat-sr-only" for="${scope}-chat-text">LERO에게 보낼 메시지</label>
    <div class="chat-compose-box"><textarea id="${scope}-chat-text" name="text" rows="2" maxlength="10000" data-chat-input="${scope}" placeholder="${scope === 'chat' ? '공지나 링크를 보내거나, 필요한 일을 부탁해 보세요.' : '예: 이 공지를 읽고 준비할 일과 제출 마감을 정리해 줘'}" ${unavailable ? 'readonly' : ''}>${esc(inputs[scope])}</textarea>
    <div class="chat-compose-tools"><button type="button" class="chat-attach-button" data-chat-action="attach" data-chat-scope="${scope}" aria-label="파일 또는 공지 캡처 첨부" title="PDF·TXT·PNG·JPEG 첨부" ${unavailable ? 'disabled' : ''}>${glyph('clip')}<span>파일 첨부</span></button><span class="chat-file-hint">최대 4MB</span><button type="submit" class="chat-send-button" data-chat-submit aria-label="LERO에게 메시지 보내기" ${unavailable || !inputs[scope].trim() && !attachment ? 'disabled' : ''}>${busy ? '<span class="chat-network-spinner" aria-hidden="true"></span>' : glyph('send')}</button></div></div>
    <input type="file" class="chat-file-input" data-chat-file="${scope}" accept="image/png,image/jpeg,application/pdf,text/plain,.png,.jpg,.jpeg,.pdf,.txt" tabindex="-1" aria-label="첨부할 파일 선택">
    <div class="chat-composer-note"><span>계획은 내용을 확인하고 승인한 뒤 등록해요.</span><span class="chat-key-hint">Enter 전송 · Shift + Enter 줄바꿈</span></div>
  </form>`;
}

export function chatView() {
  if (!context || !currentOwner()) return '';
  scrollBottom();
  return `<section class="lero-chat" data-chat-scope="chat"><header class="chat-page-head"><div><p class="chat-eyebrow">나의 준비를 함께 챙기는 LERO</p><h1>이제, 대화로 챙겨요</h1><p>해야 할 일도, 새로 받은 공지도 여기에서 정리하세요.</p></div><a class="chat-library-link" href="#sources">${glyph('folder')}자료함 보기</a></header>
    ${conversationControls()}<div class="chat-layout"><section class="chat-surface" aria-label="LERO와 대화"><div class="chat-surface-title"><span class="chat-small-mark">${assistantImage()}</span><strong>LERO</strong><span>${esc(conversations.find(value => value.id === activeConversationId)?.title || '공지에서 실행까지, 함께')}</span></div>
      <div id="chat-thread" class="chat-thread" role="log" aria-label="대화 내용" aria-live="polite" aria-relevant="additions" aria-busy="${busy}">
      ${loadError ? `<div class="chat-load-error"><strong>대화를 불러오지 못했어요</strong><p>${esc(loadError)}</p><button type="button" data-chat-action="reload">다시 불러오기</button></div>` : ''}
      ${cache.messages.length ? cache.messages.map(messageView).join('') : `<div class="chat-welcome"><span class="chat-welcome-mark">${assistantImage()}</span><p class="chat-welcome-label">반가워요, LERO예요</p><h2>어떤 일을<br>함께 챙겨볼까요?</h2><p>받은 공지를 보내면 준비할 일을 찾고,<br>이미 등록한 할 일도 여기에서 챙길 수 있어요.</p><div class="chat-welcome-examples"><span>공지·링크·파일</span><span>준비 계획</span><span>할 일·일정 관리</span></div></div>`}
      ${busy && pendingSend ? `<article class="chat-message is-user is-pending"><span class="chat-avatar" aria-hidden="true">나</span><div class="chat-message-body"><div class="chat-message-author">나</div><p class="chat-message-text">${esc(pendingSend)}</p></div></article><div class="chat-network-status" role="status"><span class="chat-network-spinner" aria-hidden="true"></span>요청을 처리하고 있어요</div>` : ''}
      </div>${composer('chat')}</section>
      <aside class="chat-aside" aria-label="대화 도우미">${cache.pendingDraftId ? draftCard(cache.pendingDraftId, true) : `<section class="chat-plan-empty"><span>${glyph('check')}</span><h2>확인할 계획이 모이는 곳</h2><p>공지를 보내면 먼저 초안을 보여드려요. 확인한 계획만 일정과 할 일로 등록돼요.</p></section>`}<section class="chat-prompt-panel"><p class="chat-section-label">이렇게 부탁해 보세요</p>${suggestedPrompts('chat')}<p class="chat-prompt-note">서비스 연결이 필요하면 대화에서 바로 안내해요.</p></section><p class="chat-source-note">자료 속 날짜가 불분명하면 직접 확인해 주세요. 원문과 계획을 함께 보면 더 정확하게 준비할 수 있어요.</p></aside>
    </div></section>`;
}

export function quickComposer() {
  if (!context || !currentOwner()) return '';
  const data = context.getState().data;
  const pendingCount = (data.items ?? []).filter(item => item.kind === 'task' && !item.done).length;
  const draftCount = (data.drafts ?? []).filter(draft => draft.status === 'draft').length;
  const now = new Date();
  const date = now.toLocaleDateString('ko-KR', {timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long'});
  const dateKey = now.toLocaleDateString('sv-SE', {timeZone: 'Asia/Seoul'});
  return `<section class="chat-quick" data-chat-scope="quick" aria-labelledby="today-chat-title"><header class="chat-quick-head"><div><time class="chat-quick-date" datetime="${dateKey}">${esc(date)}</time><h1 id="today-chat-title">오늘은 이 일부터 챙겨요</h1><p class="chat-quick-count">남은 할 일 ${pendingCount}개 · 확인할 계획 ${draftCount}개</p></div><div class="chat-quick-actions"><a href="#add/text" class="btn secondary">${glyph('plus')}자료 추가</a><a href="#chat" class="chat-quick-open">대화 열기${glyph('arrow')}</a></div></header>${composer('quick')}</section>`;
}

function scopeOf(form) { return form?.id === 'quick-chat-form' ? 'quick' : 'chat'; }

async function send(payload, scope, label) {
  const user = currentOwner();
  if (!user || busy || conversationBusy || reading.chat || reading.quick) return;
  const accountTicket = requestTicket();
  const previousText = inputs[scope];
  const previousAttachment = attachments[scope];
  conversationBusy = true;
  await renderUI();
  try {
    await loadConversations();
    if (!sameAccount(accountTicket)) return;
    if (!activeConversationId) await createConversation();
    if (!sameAccount(accountTicket) || !activeConversationId) return;
    inputs[scope] = previousText;
    attachments[scope] = previousAttachment;
  } catch (error) {
    if (sameAccount(accountTicket)) {
      inputs[scope] = previousText;
      attachments[scope] = previousAttachment;
      context.toast(error.message || '대화를 준비하지 못했어요. 다시 시도해 주세요.');
    }
    return;
  } finally {
    if (sameAccount(accountTicket)) {
      conversationBusy = false;
      await renderUI();
    }
  }
  if (!sameAccount(accountTicket) || !activeConversationId) return;
  const ticket = requestTicket();
  busy = true;
  pendingSend = label || payload.text || previousAttachment?.source.name || '선택한 요청 처리';
  revision += 1;
  await renderUI();
  if (!current(ticket)) return;
  let accepted = false;
  try {
    const result = await context.api('/api/chat', {method: 'POST', body: {...payload, conversationId: ticket.conversationId}});
    if (!current(ticket)) return;
    accepted = true;
    if (result.loggedOut) {
      blockedOwner = ticket.owner;
      reset(null);
      try { await context.refresh(); }
      catch { context.toast('로그아웃했어요. 화면을 새로 열어 주세요.'); }
      currentOwner();
      await renderUI();
      return;
    }
    cache = normalize(result);
    loaded = true;
    loadError = '';
    if (inputs[scope] === previousText) inputs[scope] = '';
    if (attachments[scope] === previousAttachment) attachments[scope] = null;
    try { await context.refresh(); }
    catch { if (current(ticket)) context.toast('요청은 처리됐어요. 최신 계획을 보려면 화면을 다시 불러와 주세요.'); }
    if (!current(ticket)) return;
    try { await loadConversations(true); } catch { /* The accepted reply remains visible if only the list refresh fails. */ }
    if (!current(ticket)) return;
    if (scope === 'quick') location.hash = 'chat';
  } catch (error) {
    if (current(ticket)) {
      if (error.status === 404) {
        try { await loadConversations(true); } catch { /* Keep the current input for retry when offline. */ }
      }
      if (sameAccount(ticket)) context.toast(error.message || '메시지를 보내지 못했어요. 다시 보내 주세요.');
    }
  } finally {
    if (sameAccount(ticket)) {
      if (current(ticket)) { busy = false; pendingSend = null; }
      await renderUI();
      if (current(ticket) && !accepted) focusInput(scope);
    }
  }
}

async function selectConversation(id) {
  if (busy || conversationBusy || reading.chat || reading.quick || !conversations.some(value => value.id === id)) return;
  activateConversation(id);
  const ticket = requestTicket();
  conversationBusy = true;
  await renderUI();
  if (sameAccount(ticket)) {
    conversationBusy = false;
    await renderUI();
    focusInput('chat');
  }
}

async function changeConversations(action, id) {
  if (!currentOwner() || busy || conversationBusy || reading.chat || reading.quick) return;
  const ticket = requestTicket();
  conversationBusy = true;
  await renderUI();
  try {
    if (action === 'new-conversation') {
      await createConversation();
      if (sameAccount(ticket)) location.hash = 'chat';
    } else if (id) {
      await context.api('/api/chat/threads/' + encodeURIComponent(id), {method: 'DELETE'});
      if (!sameAccount(ticket)) return;
      conversations = conversations.filter(value => value.id !== id);
      if (activeConversationId === id) activateConversation(conversations[0]?.id ?? null);
      conversationsLoaded = true;
      context.toast('대화를 삭제했어요. 등록한 계획과 자료는 그대로예요.');
    }
  } catch (error) {
    if (sameAccount(ticket)) {
      if (error.status === 404) { try { await loadConversations(true); } catch {} }
      context.toast(error.message || '대화 목록을 변경하지 못했어요.');
    }
  } finally {
    if (sameAccount(ticket)) {
      conversationBusy = false;
      await renderUI();
    }
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!['chat-form', 'quick-chat-form'].includes(form?.id)) return;
  event.preventDefault();
  const scope = scopeOf(form);
  const input = form.querySelector('[data-chat-input]');
  inputs[scope] = input?.value ?? inputs[scope];
  const text = inputs[scope].trim();
  if (text.length > 10000) { context.toast('메시지는 1만 자 이내로 보내 주세요.'); return; }
  if (!text && !attachments[scope]) return;
  await send({text, ...(attachments[scope] ? {attachment: attachments[scope].source} : {})}, scope);
}

async function handleClick(event) {
  const button = event.target.closest?.('[data-chat-action]');
  if (!button) return;
  const action = button.dataset.chatAction;
  if (!currentOwner()) return;
  if (busy || conversationBusy || button.disabled) { event.preventDefault(); return; }
  const scope = button.dataset.chatScope === 'quick' ? 'quick' : 'chat';
  if (action === 'connect') {
    event.preventDefault();
    const href = connectHref(button.getAttribute('href'));
    if (href) location.assign(href);
    return;
  }
  event.preventDefault();
  if (action === 'new-conversation' || action === 'delete-conversation') {
    await changeConversations(action, button.dataset.conversationId);
  } else if (action === 'select-conversation') {
    await selectConversation(button.dataset.conversationId);
  } else if (action === 'prompt') {
    inputs[scope] = String(button.dataset.prompt || '').slice(0, 10000);
    await renderUI();
    focusInput(scope);
  } else if (action === 'attach') {
    document.querySelector(`[data-chat-file="${scope}"]`)?.click();
  } else if (action === 'remove-file') {
    attachments[scope] = null;
    await renderUI();
    focusInput(scope);
  } else if (action === 'reload') {
    loaded = false;
    conversationsLoaded = false;
    await loadChat();
    await renderUI();
  } else if (action === 'approve') {
    const id = button.dataset.draftId;
    if (!canApprove(id)) { context.toast('가장 최근 계획의 내용과 날짜를 먼저 확인해 주세요.'); return; }
    await send({text: '', action: {kind: 'approve', draftId: id, version: draft(id).version}}, 'chat', '확인한 계획 등록');
  } else if (action === 'drive-import') {
    const id = button.dataset.fileId;
    const file = cache.messages.flatMap(message => Array.isArray(message.files) ? message.files : []).find(value => value.id === id);
    if (!file) { context.toast('대화에서 가져올 자료를 다시 선택해 주세요.'); return; }
    await send({text: '', action: {kind: 'drive-import', fileId: id}}, 'chat', `${file.name || '선택한 자료'} 가져오기`);
  }
}

function handleInput(event) {
  const input = event.target;
  const scope = input?.dataset?.chatInput;
  if (!['chat', 'quick'].includes(scope) || !currentOwner()) return;
  inputs[scope] = input.value;
  resize(input);
  const submit = input.closest('form')?.querySelector('[data-chat-submit]');
  if (submit) submit.disabled = busy || conversationBusy || reading[scope] || !input.value.trim() && !attachments[scope];
}

function handleKeydown(event) {
  const input = event.target;
  if (!['chat', 'quick'].includes(input?.dataset?.chatInput) || event.key !== 'Enter'
      || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!busy && !conversationBusy) input.closest('form')?.requestSubmit();
}

async function handleFile(event) {
  const input = event.target;
  if (input?.hasAttribute?.('data-chat-conversation')) {
    await selectConversation(input.value);
    return;
  }
  const scope = input?.dataset?.chatFile;
  if (!['chat', 'quick'].includes(scope) || !currentOwner() || busy || conversationBusy || reading[scope]) return;
  const file = input.files?.[0];
  if (!file) return;
  const extension = file.name.split('.').pop().toLowerCase();
  const mime = allowedMimes.includes(file.type) ? file.type : !file.type || file.type === 'application/octet-stream' ? fallbackMimes[extension] : null;
  if (!file.size || file.size > MAX_FILE || !allowedMimes.includes(mime)) {
    input.value = '';
    context.toast('4MB 이하 PDF·TXT·PNG·JPEG 파일을 선택해 주세요.');
    return;
  }
  const ticket = requestTicket();
  reading[scope] = true;
  await renderUI();
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        if (comma < 0) reject(new Error('파일을 읽을 수 없어요. 다시 선택해 주세요.'));
        else resolve(result.slice(comma + 1));
      };
      reader.onerror = reader.onabort = () => reject(new Error('파일을 읽을 수 없어요. 다시 선택해 주세요.'));
      reader.readAsDataURL(file);
    });
    if (current(ticket)) attachments[scope] = {size: file.size, source: {
      kind: mime.startsWith('image/') ? 'image' : 'file', mime, name: file.name.slice(0, 180), data}};
  } catch (error) { if (current(ticket)) context.toast(error.message); }
  finally {
    if (current(ticket)) {
      reading[scope] = false;
      await renderUI();
      focusInput(scope);
    }
  }
}
