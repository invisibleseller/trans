// SPA client. Hash routing for top-level views (#/, #/login, #/account).
// Room session is in-memory only.

const LANGS = [
  { code: 'zh', name: '中文',     english: 'Chinese',  whisper: 'zh' },
  { code: 'en', name: 'English',  english: 'English',  whisper: 'en' },
  { code: 'ja', name: '日本語',   english: 'Japanese', whisper: 'ja' },
  { code: 'de', name: 'Deutsch',  english: 'German',   whisper: 'de' },
  { code: 'ru', name: 'Русский',  english: 'Russian',  whisper: 'ru' },
  { code: 'fr', name: 'Français', english: 'French',   whisper: 'fr' },
];

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
const AUDIO_BATCH_FRAMES = 8;

const $ = (id) => document.getElementById(id);
const langByCode = (c) => LANGS.find((l) => l.code === c) || LANGS[0];

const prefs = {
  myLang: localStorage.getItem('rti_my_lang') || 'zh',
};

const session = {
  config: null,     // { trialSeconds, gateEnabled, ... }
};

const room = {
  id: null,
  password: '',
  ws: null,
  role: null,
  peerPresent: false,
  peerLanguage: null,
  myLanguage: prefs.myLang,
  model: null,
  ticket: null,
  anonymous: true,
  trialSeconds: 30,
  remainingSeconds: 0,

  oai: null,
  audioCtx: null,
  audioSource: null,
  audioNode: null,
  stream: null,
  audioBatch: [],

  // Outgoing pane: each user item gets a block with [source] + [translation].
  // userItemId -> { containerEl, sourceEl, translationEl, sourceText, translationText, sourceDone, translationDone }
  outgoingBlocks: new Map(),
  // Map responseId -> userItemId, to glue model translation back to user item.
  responseToItem: new Map(),
  // For chunks of text relayed to peer (don't include their full text every chunk).
  responseSentLen: new Map(),
  lastUserItemId: null,
  // Incoming pane: peer's translated speech in our language.
  incomingLines: new Map(),

  micEnabled: false,
};

// ---------- Hash routing ----------

const VIEW_BY_HASH = {
  '':         'view-home',
  '#/':       'view-home',
  '#/login':  'view-login',
  '#/account':'view-account',
};

function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
  $(id).classList.add('active');
}

function applyHashRoute() {
  // Room view is opened imperatively, not via hash.
  if ($('view-room').classList.contains('active') && location.hash.startsWith('#/')) {
    leaveRoom();
  }
  const h = location.hash || '#/';
  // Account / login views are dormant in this build; bounce back home.
  const v = (h === '#/login' || h === '#/account') ? 'view-home'
          : (VIEW_BY_HASH[h] || 'view-home');
  showView(v);
}

window.addEventListener('hashchange', applyHashRoute);

document.querySelectorAll('[data-back]').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); location.hash = '#/'; });
});
$('goCreate').onclick = () => showView('view-create');
$('goJoin').onclick   = () => showView('view-join');

function fillLangSelect(sel, current) {
  sel.innerHTML = '';
  for (const l of LANGS) {
    const o = document.createElement('option');
    o.value = l.code; o.textContent = l.name;
    sel.appendChild(o);
  }
  sel.value = current;
}
fillLangSelect($('createLang'), prefs.myLang);
fillLangSelect($('joinLang'),   prefs.myLang);
fillLangSelect($('myLang'),     prefs.myLang);

// ---------- Boot: load /api/config + /api/me ----------

(async function boot() {
  try {
    session.config = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  } catch { session.config = {}; }
  $('gateLogout').hidden = !session.config?.gateEnabled;
  applyHashRoute();
})();

$('gateLogout').onclick = async () => {
  try { await fetch('/api/site-auth/logout', { method: 'POST' }); } catch {}
  location.href = '/site-auth';
};

function fmtSeconds(s) {
  s = Number(s || 0);
  if (s < 60) return s.toFixed(1) + ' 秒';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return m + ' 分 ' + (r ? r + ' 秒' : '');
}

// ---------- Login / Magic link ----------

$('magicForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('magicEmail').value.trim().toLowerCase();
  $('magicErr').hidden = true; $('magicMsg').hidden = true;
  $('magicBtn').disabled = true;
  try {
    const r = await fetch('/api/auth/magic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'failed');
    showFlash('magicMsg', '邮件已发送，请打开邮箱中的登录链接（15 分钟内有效）。');
  } catch (err) {
    showFlash('magicErr', err.message || String(err), true);
  } finally {
    $('magicBtn').disabled = false;
  }
});

function showFlash(id, text, isErr = false) {
  const el = $(id);
  el.textContent = text;
  el.hidden = false;
}

// ---------- Account ----------

async function refreshAccount() {
  // Refresh balance.
  const me = await fetch('/api/me').then(r => r.json()).catch(() => null);
  if (!me?.authenticated) { location.hash = '#/login'; return; }
  session.me = me;
  updateNav();
  $('balancePill').textContent = '余额：' + fmtSeconds(me.balanceSeconds);
  const identity = [me.email, me.displayName].filter(Boolean).join(' · ') || '匿名账户';
  $('accountIdentity').textContent = identity;

  // Recent usage.
  const ul = $('usageList');
  ul.innerHTML = '<li class="muted">加载中…</li>';
  try {
    const data = await fetch('/api/me/usage').then(r => r.json());
    if (!data.usage || !data.usage.length) {
      ul.innerHTML = '<li class="muted">暂无记录</li>';
    } else {
      ul.innerHTML = '';
      for (const u of data.usage) {
        const li = document.createElement('li');
        const left = document.createElement('span');
        left.textContent = u.reason || '使用';
        const right = document.createElement('span');
        const credit = u.seconds < 0;
        right.className = credit ? 'credit' : 'debit';
        right.textContent = (credit ? '+' : '-') + fmtSeconds(Math.abs(u.seconds));
        li.append(left, right);
        ul.appendChild(li);
      }
    }
  } catch {
    ul.innerHTML = '<li class="muted">加载失败</li>';
  }
}

$('logoutBtn').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  session.me = { authenticated: false };
  updateNav();
  location.hash = '#/';
};

$('redeemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('redeemErr').hidden = true; $('redeemMsg').hidden = true;
  const code = $('redeemCode').value.trim().toUpperCase();
  if (!code) return;
  $('redeemBtn').disabled = true;
  try {
    const r = await fetch('/api/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msgs = { invalid: '兑换码无效', used: '兑换码已被使用', empty: '请输入兑换码', unauthenticated: '请先登录' };
      throw new Error(msgs[data.error] || data.error || '兑换失败');
    }
    showFlash('redeemMsg', `兑换成功，已到账 ${fmtSeconds(data.seconds)}。`);
    $('redeemCode').value = '';
    refreshAccount();
  } catch (err) {
    showFlash('redeemErr', err.message || String(err), true);
  } finally {
    $('redeemBtn').disabled = false;
  }
});

// ---------- Create / Join room ----------

$('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('createPwd').value;
  const myLang   = $('createLang').value;
  $('createBtn').disabled = true;
  $('createErr').hidden = true;
  try {
    const resp = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'create failed');
    localStorage.setItem('rti_my_lang', myLang);
    enterRoom(data.roomId, password, myLang);
  } catch (err) {
    showErr('createErr', err.message || String(err));
  } finally {
    $('createBtn').disabled = false;
  }
});

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('joinRoom').value.trim().toUpperCase();
  const pwd = $('joinPwd').value;
  const myLang = $('joinLang').value;
  if (!id) return;
  localStorage.setItem('rti_my_lang', myLang);
  enterRoom(id, pwd, myLang);
});

function showErr(id, msg) { const el = $(id); el.textContent = msg; el.hidden = false; }

// ---------- Room ----------

function enterRoom(roomId, password, myLang) {
  room.id = roomId;
  room.password = password;
  room.myLanguage = myLang;
  $('roomCode').textContent = roomId;
  $('myLang').value = myLang;
  setStatus('连接房间…');
  setPeerLabel(null);
  resetRoomPanes();
  showView('view-room');
  connectWS();
}

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}
function setPeerLabel(language) {
  const el = $('peerLangLabel');
  if (!language) { el.textContent = '对方未到'; el.classList.remove('connected'); }
  else { el.textContent = '对方说 ' + langByCode(language).name; el.classList.add('connected'); }
}
function resetRoomPanes() {
  $('incoming').innerHTML = '';
  $('outgoing').innerHTML = '';
  room.outgoingBlocks.clear();
  room.responseToItem.clear();
  room.responseSentLen.clear();
  room.incomingLines.clear();
  room.lastUserItemId = null;
}
function updateQuotaUI() {
  const remaining = Math.max(0, Number(room.remainingSeconds || 0));
  const el = $('quota');
  if (room.anonymous) {
    el.textContent = `试用剩余 ${remaining.toFixed(1)}s / ${room.trialSeconds}s`;
  } else {
    el.textContent = `余额剩余 ${fmtSeconds(remaining)}`;
  }
  el.classList.toggle('low', remaining > 0 && remaining < 10);
  el.classList.toggle('empty', remaining <= 0);
}

$('myLang').addEventListener('change', () => {
  room.myLanguage = $('myLang').value;
  localStorage.setItem('rti_my_lang', room.myLanguage);
  if (room.ws && room.ws.readyState === 1) {
    room.ws.send(JSON.stringify({ type: 'set_language', language: room.myLanguage }));
  }
  if (room.oai && room.oai.readyState === 1) sendSessionUpdate();
});

$('copyRoom').onclick = async () => {
  try { await navigator.clipboard.writeText(room.id); setStatus('房间号已复制', 'live'); }
  catch {}
};
$('leaveBtn').onclick = () => { leaveRoom(); location.hash = '#/'; };
$('micBtn').onclick = async () => {
  if (room.micEnabled) { stopMic(); return; }
  if (!room.peerPresent) { setStatus('请等对方加入', 'warn'); return; }
  if (Number(room.remainingSeconds || 0) <= 0) {
    setStatus(room.anonymous ? '试用额度已用完，登录后充值可继续' : '余额不足', 'err');
    return;
  }
  try { await startMic(); }
  catch (err) {
    console.error(err);
    setStatus('错误: ' + (err.message || err), 'err');
    stopMic();
  }
};

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/rooms/${encodeURIComponent(room.id)}/ws`;
  const ws = new WebSocket(url);
  room.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'auth',
      password: room.password,
      language: room.myLanguage,
    }));
    setStatus('鉴权中…');
  };
  ws.onmessage = (evt) => {
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMsg(msg);
  };
  ws.onclose = () => {
    if (!room.id) return;
    setStatus('连接已断开', 'err');
    stopMic();
  };
  ws.onerror = () => setStatus('连接错误', 'err');
}

function handleServerMsg(msg) {
  switch (msg.type) {
    case 'joined':
      room.role = msg.role;
      room.peerPresent = !!msg.peerPresent;
      room.peerLanguage = msg.peerLanguage || null;
      room.model = msg.model || room.model;
      room.ticket = msg.ticket || null;
      room.anonymous = !!msg.anonymous;
      room.trialSeconds = Number(msg.trialSeconds || 30);
      if (msg.anonymous) {
        room.remainingSeconds = Math.max(0, room.trialSeconds - Number(msg.trialUsedSeconds || 0));
      } else {
        room.remainingSeconds = Number(msg.balanceSeconds || 0);
      }
      setPeerLabel(room.peerLanguage);
      setStatus(room.peerPresent ? '已就绪' : '等待对方加入…', room.peerPresent ? 'live' : 'warn');
      updateQuotaUI();
      break;
    case 'ticket':
      room.ticket = msg.ticket;
      break;
    case 'peer_joined':
      room.peerPresent = true;
      room.peerLanguage = msg.language;
      setPeerLabel(room.peerLanguage);
      setStatus('已就绪', 'live');
      if (room.oai && room.oai.readyState === 1) sendSessionUpdate();
      break;
    case 'peer_language':
      room.peerLanguage = msg.language;
      setPeerLabel(room.peerLanguage);
      if (room.oai && room.oai.readyState === 1) sendSessionUpdate();
      break;
    case 'peer_left':
      room.peerPresent = false;
      room.peerLanguage = null;
      setPeerLabel(null);
      setStatus('对方已离开', 'warn');
      stopMic();
      break;
    case 'peer_subtitle':
      renderIncoming(msg.id, msg.text, msg.final);
      break;
    case 'quota_update':
      room.remainingSeconds = Number(msg.remainingSeconds || 0);
      updateQuotaUI();
      break;
    case 'quota_exceeded':
      room.remainingSeconds = 0;
      updateQuotaUI();
      setStatus(msg.reason === 'balance' ? '余额已用完' : '试用额度已用完', 'err');
      stopMic();
      break;
    case 'error':
      if (msg.error === 'bad_password') {
        showErr('joinErr', '房间密码错误'); leaveRoom(); showView('view-join');
      } else if (msg.error === 'room_full') {
        showErr('joinErr', '该房间已有两人在线'); leaveRoom(); showView('view-join');
      } else {
        setStatus('错误: ' + (msg.detail || msg.error), 'err');
      }
      break;
  }
}

function leaveRoom() {
  stopMic();
  if (room.ws) { try { room.ws.close(); } catch {} room.ws = null; }
  room.id = null;
  room.peerPresent = false;
  room.peerLanguage = null;
  room.ticket = null;
}

// ---------- Realtime (WS proxy) ----------

function buildInstructions() {
  const src = langByCode(room.myLanguage);
  const tgt = langByCode(room.peerLanguage || room.myLanguage);
  return (
    `You are a professional simultaneous interpreter. ` +
    `The user speaks ${src.english}. ` +
    `Translate every utterance into natural, idiomatic ${tgt.english}. ` +
    `Output ONLY the ${tgt.english} translation — no explanations, no source text, no labels. ` +
    `Preserve tone. Begin emitting as soon as enough has been said; do not wait for the full sentence. ` +
    `Keep proper nouns and well-known technical terms in their conventional form.`
  );
}
function buildSessionConfig() {
  const src = langByCode(room.myLanguage);
  return {
    modalities: ['text'],
    instructions: buildInstructions(),
    input_audio_format: 'pcm16',
    input_audio_transcription: { model: 'whisper-1', language: src.whisper },
    turn_detection: {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 600,
      create_response: true,
    },
    temperature: 0.6,
  };
}
function sendSessionUpdate() {
  room.oai.send(JSON.stringify({ type: 'session.update', session: buildSessionConfig() }));
}

async function ensureTicket() {
  if (room.ticket) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ticket timeout')), 3000);
    const onMsg = (evt) => {
      let m; try { m = JSON.parse(evt.data); } catch { return; }
      if (m.type === 'ticket') {
        room.ws.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve();
      }
    };
    room.ws.addEventListener('message', onMsg);
    room.ws.send(JSON.stringify({ type: 'request_ticket' }));
  });
}

async function startMic() {
  setStatus('请求麦克风…');
  room.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      channelCount: 1, sampleRate: SAMPLE_RATE,
    },
  });

  await ensureTicket();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ticket = room.ticket; room.ticket = null;
  const oaiUrl = `${proto}//${location.host}/api/rooms/${encodeURIComponent(room.id)}/oai?ticket=${encodeURIComponent(ticket)}`;

  setStatus('连接 Realtime…');
  const oai = new WebSocket(oaiUrl);
  oai.binaryType = 'arraybuffer';
  room.oai = oai;

  await new Promise((resolve, reject) => {
    const onOpen = () => { oai.removeEventListener('open', onOpen); resolve(); };
    oai.addEventListener('open', onOpen);
    oai.addEventListener('error', () => reject(new Error('proxy ws failed')), { once: true });
  });

  sendSessionUpdate();
  oai.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    handleRealtimeEvent(ev);
  });
  oai.addEventListener('close', () => stopMic());

  let ctx;
  try { ctx = new AudioContext({ sampleRate: SAMPLE_RATE }); }
  catch { ctx = new AudioContext(); }
  room.audioCtx = ctx;
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  room.audioSource = ctx.createMediaStreamSource(room.stream);
  room.audioNode = new AudioWorkletNode(ctx, 'pcm16');

  const needResample = ctx.sampleRate !== SAMPLE_RATE;
  const ratio = ctx.sampleRate / SAMPLE_RATE;

  room.audioBatch = [];
  let batchSamples = 0;

  room.audioNode.port.onmessage = (e) => {
    if (!room.oai || room.oai.readyState !== 1) return;
    let samples = new Int16Array(e.data);
    if (needResample) samples = downsampleInt16(samples, ratio);
    room.audioBatch.push(samples);
    batchSamples += samples.length;
    if (room.audioBatch.length >= AUDIO_BATCH_FRAMES) {
      const merged = new Int16Array(batchSamples);
      let off = 0;
      for (const b of room.audioBatch) { merged.set(b, off); off += b.length; }
      room.audioBatch = [];
      batchSamples = 0;
      try {
        room.oai.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64FromInt16(merged),
        }));
      } catch {}
    }
  };

  room.audioSource.connect(room.audioNode);
  if (ctx.state === 'suspended') await ctx.resume();

  room.micEnabled = true;
  $('micBtn').textContent = '停止';
  $('micBtn').classList.add('recording');
  $('micBtn').classList.remove('primary');
  setStatus('正在聆听', 'live');
}

function downsampleInt16(input, ratio) {
  if (ratio === 1) return input;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}
function base64FromInt16(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(s);
}

function stopMic() {
  room.micEnabled = false;
  try { room.audioSource && room.audioSource.disconnect(); } catch {}
  try { room.audioNode && room.audioNode.disconnect(); } catch {}
  if (room.audioCtx) { try { room.audioCtx.close(); } catch {} }
  if (room.stream) room.stream.getTracks().forEach((t) => t.stop());
  if (room.oai) { try { room.oai.close(); } catch {} }
  room.audioCtx = room.audioSource = room.audioNode = room.stream = room.oai = null;
  room.audioBatch = [];
  $('micBtn').textContent = '开始说话';
  $('micBtn').classList.remove('recording');
  $('micBtn').classList.add('primary');
  if (room.peerPresent && room.ws) setStatus('已就绪', 'live');
}

// ---------- Realtime event handling ----------

function handleRealtimeEvent(ev) {
  switch (ev.type) {
    case 'conversation.item.created':
      if (ev.item && ev.item.role === 'user') {
        room.lastUserItemId = ev.item.id;
        ensureOutgoingBlock(ev.item.id);
      }
      break;
    case 'conversation.item.input_audio_transcription.delta':
      setBlockSource(ev.item_id, ev.delta || '', false, /*append*/ true);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      setBlockSource(ev.item_id, ev.transcript || '', true, /*append*/ false);
      break;
    case 'response.created':
      if (ev.response?.id && room.lastUserItemId) {
        room.responseToItem.set(ev.response.id, room.lastUserItemId);
      }
      break;
    case 'response.text.delta':
      handleResponseDelta(ev.response_id, ev.delta || '', false);
      break;
    case 'response.text.done':
      handleResponseDelta(ev.response_id, '', true, ev.text || '');
      break;
    case 'response.done':
      if (ev.response && ev.response.output) {
        const text = ev.response.output
          .flatMap((o) => o.content || [])
          .map((c) => c.text || c.transcript || '')
          .join('');
        if (text) handleResponseDelta(ev.response.id, '', true, text);
      }
      break;
    case 'error':
      console.error('Realtime error', ev);
      setStatus('错误: ' + (ev.error?.message || 'unknown'), 'err');
      break;
  }
}

function ensureOutgoingBlock(itemId) {
  let blk = room.outgoingBlocks.get(itemId);
  if (blk) return blk;
  const container = document.createElement('div');
  container.className = 'line outgoing-block';
  const source = document.createElement('div');
  source.className = 'source interim';
  source.textContent = '…';
  const translation = document.createElement('div');
  translation.className = 'translation interim';
  translation.textContent = '';
  container.append(source, translation);
  $('outgoing').appendChild(container);
  blk = {
    container, sourceEl: source, translationEl: translation,
    sourceText: '', translationText: '',
    sourceDone: false, translationDone: false,
  };
  room.outgoingBlocks.set(itemId, blk);
  return blk;
}

function setBlockSource(itemId, payload, done, append) {
  const blk = ensureOutgoingBlock(itemId);
  if (done) {
    blk.sourceText = payload;
    blk.sourceDone = true;
    blk.sourceEl.classList.remove('interim');
  } else {
    if (append) blk.sourceText += payload; else blk.sourceText = payload;
  }
  blk.sourceEl.textContent = blk.sourceText || '…';
  scrollBottom($('outgoing'));
}

function setBlockTranslation(itemId, payload, done, append) {
  const blk = ensureOutgoingBlock(itemId);
  if (done) {
    if (payload && payload.length > blk.translationText.length) blk.translationText = payload;
    blk.translationDone = true;
    blk.translationEl.classList.remove('interim');
  } else {
    if (append) blk.translationText += payload; else blk.translationText = payload;
  }
  blk.translationEl.textContent = blk.translationText;
  scrollBottom($('outgoing'));
}

function handleResponseDelta(responseId, delta, done, fullText) {
  // 1. Show locally in our own outgoing pane (so speaker can verify translation).
  const itemId = room.responseToItem.get(responseId) || room.lastUserItemId;
  if (itemId) {
    if (done) setBlockTranslation(itemId, fullText || '', true, false);
    else setBlockTranslation(itemId, delta, false, true);
  }
  // 2. Forward (incrementally) to peer over WS for them to render.
  const fullSoFar = (room.outgoingBlocks.get(itemId)?.translationText) || (delta || fullText || '');
  if (room.ws && room.ws.readyState === 1) {
    const sentLen = room.responseSentLen.get(responseId) || 0;
    if (fullSoFar.length > sentLen || done) {
      room.ws.send(JSON.stringify({
        type: 'subtitle',
        id: 'r_' + responseId,
        text: fullSoFar,
        final: !!done,
      }));
      room.responseSentLen.set(responseId, fullSoFar.length);
    }
  }
}

function renderIncoming(id, text, final) {
  let row = room.incomingLines.get(id);
  if (!row) {
    const el = document.createElement('div');
    el.className = 'line interim';
    $('incoming').appendChild(el);
    row = { el };
    room.incomingLines.set(id, row);
  }
  row.el.textContent = text || '…';
  if (final) row.el.classList.remove('interim');
  scrollBottom($('incoming'));
}

function scrollBottom(el) { el.scrollTop = el.scrollHeight; }

window.addEventListener('beforeunload', () => { leaveRoom(); });
