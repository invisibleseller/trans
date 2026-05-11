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

  // Unified conversation, time-ordered. msgId -> entry.
  // Entry: { speaker: 'me'|'peer', sourceText, sourceLang, sourceFinal,
  //          translationText, translationLang, translationFinal,
  //          containerEl, sourceEl, translationEl, ts }
  messages: new Map(),
  messageOrder: [],
  // Map OpenAI responseId -> msgId so we can route the translation back
  // onto the same user item.
  responseToMsg: new Map(),
  lastUserItemId: null,

  // Display mode for finalized messages: bilingual | mine | peer.
  displayMode: localStorage.getItem('rti_display_mode') || 'bilingual',

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
  applyHashRoute();
})();

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

// Create flow: prove you have the operator-only creation password,
// then get back a fresh roomId (the share code).
async function createRoom(sitePassword, myLang) {
  if (!sitePassword) return;
  $('createErr').hidden = true;
  $('createBtn').disabled = true;
  try {
    const resp = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sitePassword }),
    });
    let data = null;
    try { data = await resp.json(); } catch {}
    if (!resp.ok) {
      const code = data?.error;
      const msg = code === 'bad_site_password' ? '创建密码错误' : (code || '创建失败');
      throw new Error(msg);
    }
    localStorage.setItem('rti_my_lang', myLang);
    enterRoom(data.roomId, '', myLang);
  } catch (err) {
    showErr('createErr', err.message || String(err));
  } finally {
    $('createBtn').disabled = false;
  }
}

// Join flow: no extra auth — just take the share code as-is and open
// the room WS. If the room hasn't been created (or expired), the WS
// will close before we ever get a "joined" message and we surface that.
function joinRoom(roomCode, myLang) {
  if (!roomCode) return;
  $('joinErr').hidden = true;
  localStorage.setItem('rti_my_lang', myLang);
  enterRoom(roomCode.toUpperCase(), '', myLang);
}

$('createForm').addEventListener('submit', (e) => {
  e.preventDefault();
  createRoom($('createPwd').value, $('createLang').value);
});

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom($('joinRoom').value.trim(), $('joinLang').value);
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
  $('conversation').innerHTML = '';
  room.messages.clear();
  room.messageOrder.length = 0;
  room.responseToMsg.clear();
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
  room.authed = false;
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
    if (!room.authed) {
      // WS dropped before we ever joined → room doesn't exist or password
      // was wrong. Bounce back to the join form with a clear message.
      const code = room.id;
      stopMic();
      leaveRoom();
      showView('view-join');
      showErr('joinErr', '房间码无效或房间已过期：' + code);
      return;
    }
    setStatus('连接已断开', 'err');
    stopMic();
  };
  ws.onerror = () => setStatus('连接错误', 'err');
}

function handleServerMsg(msg) {
  switch (msg.type) {
    case 'joined':
      room.authed = true;
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
      applyPeerSubtitle(msg);
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
    // gpt-4o-realtime-preview only knows the `modalities` key.
    // Sending `output_modalities` causes the WHOLE session.update to
    // be rejected, leaving the session on default (server_vad + audio +
    // generic chat instructions), so the model replies in the caller's
    // language instead of translating. Verified against the live API
    // with /tmp/solo-e2e.mjs.
    modalities: ['text'],
    instructions: buildInstructions(),
    input_audio_format: 'pcm16',
    input_audio_transcription: { model: 'gpt-4o-transcribe', language: src.whisper },
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

  // Live mic level — lets the user see whether their voice is actually
  // being captured. If the bar never moves the OS / browser isn't routing
  // audio to this tab, regardless of what "正在聆听" says.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.3;
  room.audioSource.connect(analyser);
  room.audioAnalyser = analyser;
  const levelBuf = new Uint8Array(analyser.fftSize);
  showMicLevel(true);
  const pollLevel = () => {
    if (!room.audioAnalyser) return;
    room.audioAnalyser.getByteTimeDomainData(levelBuf);
    let max = 0;
    for (let i = 0; i < levelBuf.length; i++) {
      const d = Math.abs(levelBuf[i] - 128);
      if (d > max) max = d;
    }
    setMicLevel(Math.min(100, Math.round((max * 100) / 64)));
    requestAnimationFrame(pollLevel);
  };
  requestAnimationFrame(pollLevel);

  room.micEnabled = true;
  $('micBtn').textContent = '停止';
  $('micBtn').classList.add('recording');
  $('micBtn').classList.remove('primary');
  setStatus('正在聆听', 'live');
}

function setMicLevel(pct) {
  const bar = $('micLevelBar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}
function showMicLevel(show) {
  const el = $('micLevel');
  if (el) el.classList.toggle('active', !!show);
  if (!show) setMicLevel(0);
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
  try { room.audioAnalyser && room.audioAnalyser.disconnect(); } catch {}
  if (room.audioCtx) { try { room.audioCtx.close(); } catch {} }
  if (room.stream) room.stream.getTracks().forEach((t) => t.stop());
  if (room.oai) { try { room.oai.close(); } catch {} }
  room.audioCtx = room.audioSource = room.audioNode = room.stream = room.oai = null;
  room.audioAnalyser = null;
  room.audioBatch = [];
  showMicLevel(false);
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
        ensureMessage(ev.item.id, 'me');
      }
      break;
    case 'conversation.item.input_audio_transcription.delta':
      updateOwnSource(ev.item_id, ev.delta || '', false, /*append*/ true);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      updateOwnSource(ev.item_id, ev.transcript || '', true, /*append*/ false);
      break;
    case 'response.created':
      if (ev.response?.id && room.lastUserItemId) {
        room.responseToMsg.set(ev.response.id, room.lastUserItemId);
      }
      break;
    // Translation deltas: depending on Realtime version + active modality
    // the same content arrives under one of several event names. Treat them
    // all as the model's translated text for the current response.
    case 'response.text.delta':
    case 'response.output_text.delta':
    case 'response.audio_transcript.delta':
    case 'response.output_audio_transcript.delta':
      updateOwnTranslation(ev.response_id, ev.delta || '', false);
      break;
    case 'response.text.done':
    case 'response.output_text.done':
      updateOwnTranslation(ev.response_id, '', true, ev.text || '');
      break;
    case 'response.audio_transcript.done':
    case 'response.output_audio_transcript.done':
      updateOwnTranslation(ev.response_id, '', true, ev.transcript || '');
      break;
    case 'response.done':
      if (ev.response && ev.response.output) {
        const text = ev.response.output
          .flatMap((o) => o.content || [])
          .map((c) => c.text || c.transcript || '')
          .join('');
        if (text) updateOwnTranslation(ev.response.id, '', true, text);
      }
      break;
    case 'error':
      console.error('Realtime error', ev);
      setStatus('错误: ' + (ev.error?.message || JSON.stringify(ev.error || {}) || 'unknown'), 'err');
      break;
    default:
      if (ev.type && (ev.type.startsWith('response.') || ev.type.includes('error'))) {
        console.debug('[realtime]', ev.type, ev);
      }
      break;
  }
}

// ---------- Unified conversation ----------

function ensureMessage(msgId, speaker) {
  let entry = room.messages.get(msgId);
  if (entry) return entry;

  const container = document.createElement('div');
  container.className = 'msg msg-' + speaker;
  container.dataset.speaker = speaker;
  container.dataset.final = '0';

  const head = document.createElement('div');
  head.className = 'msg-head';
  const whoEl = document.createElement('span');
  whoEl.className = 'who';
  whoEl.textContent = speaker === 'me' ? '你' : '对方';
  head.appendChild(whoEl);

  const sourceEl = document.createElement('div');
  sourceEl.className = 'line source interim';
  const translationEl = document.createElement('div');
  translationEl.className = 'line translation interim';

  // "my-lang" / "peer-lang" classes drive the display-mode CSS.
  // For an outgoing message: source = my language, translation = peer language.
  // For an incoming message: source = peer language, translation = my language.
  if (speaker === 'me') {
    sourceEl.classList.add('my-lang');
    translationEl.classList.add('peer-lang');
  } else {
    sourceEl.classList.add('peer-lang');
    translationEl.classList.add('my-lang');
  }

  container.append(head, sourceEl, translationEl);
  $('conversation').appendChild(container);

  entry = {
    speaker,
    sourceText: '', sourceLang: '', sourceFinal: false,
    translationText: '', translationLang: '', translationFinal: false,
    containerEl: container, sourceEl, translationEl,
    ts: Date.now(),
  };
  room.messages.set(msgId, entry);
  room.messageOrder.push(msgId);
  return entry;
}

function refreshMessageDom(entry) {
  entry.sourceEl.textContent = entry.sourceText || (entry.sourceFinal ? '' : '…');
  entry.translationEl.textContent = entry.translationText || (entry.translationFinal ? '' : '…');
  entry.sourceEl.classList.toggle('interim', !entry.sourceFinal);
  entry.translationEl.classList.toggle('interim', !entry.translationFinal);
  const bothFinal = entry.sourceFinal && entry.translationFinal;
  entry.containerEl.dataset.final = bothFinal ? '1' : '0';
  scrollBottom($('conversation'));
}

function updateOwnSource(itemId, payload, done, append) {
  const entry = ensureMessage(itemId, 'me');
  entry.sourceLang = room.myLanguage;
  if (done) {
    entry.sourceText = payload;
    entry.sourceFinal = true;
  } else if (append) {
    entry.sourceText += payload;
  } else {
    entry.sourceText = payload;
  }
  refreshMessageDom(entry);
  sendSubtitle(itemId, entry);
}

function updateOwnTranslation(responseId, delta, done, fullText) {
  const itemId = room.responseToMsg.get(responseId) || room.lastUserItemId;
  if (!itemId) return;
  const entry = ensureMessage(itemId, 'me');
  entry.translationLang = room.peerLanguage || entry.translationLang;
  if (done) {
    if (fullText && fullText.length >= entry.translationText.length) {
      entry.translationText = fullText;
    }
    entry.translationFinal = true;
  } else {
    entry.translationText += delta;
  }
  refreshMessageDom(entry);
  sendSubtitle(itemId, entry);
}

function sendSubtitle(msgId, entry) {
  if (!room.ws || room.ws.readyState !== 1) return;
  room.ws.send(JSON.stringify({
    type: 'subtitle',
    msgId,
    source: {
      text: entry.sourceText,
      lang: entry.sourceLang,
      final: entry.sourceFinal,
    },
    translation: {
      text: entry.translationText,
      lang: entry.translationLang,
      final: entry.translationFinal,
    },
  }));
}

function applyPeerSubtitle(msg) {
  if (!msg.msgId) return;
  const entry = ensureMessage(msg.msgId, 'peer');
  // For an incoming message, source = peer's original (peer language),
  // translation = peer's render-side translation into our language.
  if (msg.source) {
    entry.sourceText = msg.source.text || '';
    entry.sourceLang = msg.source.lang || entry.sourceLang;
    entry.sourceFinal = !!msg.source.final;
  }
  if (msg.translation) {
    entry.translationText = msg.translation.text || '';
    entry.translationLang = msg.translation.lang || entry.translationLang;
    entry.translationFinal = !!msg.translation.final;
  }
  refreshMessageDom(entry);
}

function scrollBottom(el) { el.scrollTop = el.scrollHeight; }

// ---------- Display mode ----------

function applyDisplayMode(mode) {
  room.displayMode = mode;
  localStorage.setItem('rti_display_mode', mode);
  const conv = $('conversation');
  conv.classList.remove('mode-bilingual', 'mode-mine', 'mode-peer');
  conv.classList.add('mode-' + mode);
  for (const btn of document.querySelectorAll('.mode-btn')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
}

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyDisplayMode(btn.dataset.mode));
});
applyDisplayMode(room.displayMode);

// ---------- Export ----------

function exportConversation() {
  const langName = (code) => langByCode(code)?.name || code || '';
  const rows = room.messageOrder.map((id) => {
    const e = room.messages.get(id);
    if (!e) return '';
    const who = e.speaker === 'me' ? '你' : '对方';
    const t = new Date(e.ts).toLocaleTimeString();
    const src = escapeHtml(e.sourceText || '');
    const tr  = escapeHtml(e.translationText || '');
    const srcLang = langName(e.sourceLang);
    const trLang  = langName(e.translationLang);
    return `
      <div class="m">
        <div class="h"><b>${who}</b> <span class="t">${t}</span></div>
        ${src ? `<div class="s"><span class="lab">${escapeHtml(srcLang)}</span>${src}</div>` : ''}
        ${tr  ? `<div class="r"><span class="lab">${escapeHtml(trLang)}</span>${tr}</div>` : ''}
      </div>`;
  }).join('');

  const stamp = new Date().toLocaleString();
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>实时同传对话记录 ${stamp}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Helvetica Neue",sans-serif;color:#111;background:#fff;margin:2rem;max-width:780px}
  h1{font-size:1.2rem;margin:0 0 1rem}
  .meta{color:#666;font-size:.85rem;margin-bottom:1.5rem}
  .m{padding:.6rem 0;border-bottom:1px solid #eee}
  .h{font-size:.85rem;color:#555;margin-bottom:.3rem}
  .h .t{margin-left:.5rem;color:#999;font-weight:400}
  .s,.r{margin:.15rem 0;line-height:1.5}
  .s{color:#111}
  .r{color:#0050a0}
  .lab{display:inline-block;min-width:3.5em;font-size:.75rem;color:#888;margin-right:.5em}
  @media print {
    body{margin:1cm}
    .m{break-inside:avoid}
  }
</style></head><body>
<h1>实时同传对话记录</h1>
<div class="meta">导出时间：${stamp}　·　共 ${room.messageOrder.length} 条</div>
${rows || '<p style="color:#666">这次对话没有任何记录。</p>'}
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { alert('浏览器拦截了弹窗，无法导出。请允许此站点弹窗后重试。'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  })[c]);
}

$('exportBtn').addEventListener('click', exportConversation);

// ---------- Solo mode (single device, two people taking turns) ----------

const solo = {
  ws: null,
  ticket: null,
  myLang: 'zh',     // the device holder's language (what they speak / want to read)
  peerLang: 'en',   // the other person's language

  mode: 'speak',    // 'speak' | 'listen'
  // speak sub-state: idle → recording → awaiting → ready → idle
  // listen sub-state: idle → listening
  subState: 'idle',
  active: false,    // audio currently streaming to the WS?

  audioCtx: null, audioSource: null, audioNode: null, stream: null, audioBatch: [],

  // Current speak-mode message (for the 🔊 send-to-peer step).
  currentMsgId: null,

  lastUserItemId: null,
  responseToMsg: new Map(),
  messages: new Map(),
  order: [],
};

// Defaults: bottom (closer to me) = 中文; top (facing the other person) = English.
fillLangSelect($('soloMineLang'), 'zh');
fillLangSelect($('soloPeerLang'), 'en');

$('goSolo').onclick = () => { showView('view-solo-form'); };

$('soloForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sitePassword = $('soloPwd').value;
  const mineLang = $('soloMineLang').value;
  const peerLang = $('soloPeerLang').value;
  if (mineLang === peerLang) { showErr('soloErr', '两边的语言不能相同'); return; }
  $('soloErr').hidden = true;
  $('soloBtn').disabled = true;
  try { await startSolo(sitePassword, mineLang, peerLang); }
  catch (err) { showErr('soloErr', err.message || String(err)); }
  finally { $('soloBtn').disabled = false; }
});

async function startSolo(sitePassword, mineLang, peerLang) {
  const resp = await fetch('/api/solo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sitePassword }),
  });
  let data = null; try { data = await resp.json(); } catch {}
  if (!resp.ok) {
    throw new Error(data?.error === 'bad_site_password' ? '创建密码错误' : (data?.error || '失败'));
  }

  // Cache the ticket and prep the audio pipeline, but do NOT open the
  // OpenAI WS yet. A new WS is opened per side-switch in activateSoloSide
  // so each speaker gets a fresh session with clean instructions and no
  // accumulated conversation history — otherwise the model drifts into
  // chat-reply mode instead of translating.
  solo.ticket = data.ticket;
  solo.ws = null;
  solo.myLang = mineLang;
  solo.peerLang = peerLang;
  solo.active = false;
  solo.mode = 'speak';
  solo.subState = 'idle';
  resetSoloState();
  await initSoloAudio();

  applySoloMode();
  showView('view-solo');
}

async function initSoloAudio() {
  solo.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      channelCount: 1, sampleRate: SAMPLE_RATE,
    },
  });
  let ctx;
  try { ctx = new AudioContext({ sampleRate: SAMPLE_RATE }); }
  catch { ctx = new AudioContext(); }
  solo.audioCtx = ctx;
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  solo.audioSource = ctx.createMediaStreamSource(solo.stream);
  solo.audioNode = new AudioWorkletNode(ctx, 'pcm16');

  const needResample = ctx.sampleRate !== SAMPLE_RATE;
  const ratio = ctx.sampleRate / SAMPLE_RATE;
  solo.audioBatch = [];
  let batchSamples = 0;

  solo.audioNode.port.onmessage = (e) => {
    if (!solo.active || !solo.ws || solo.ws.readyState !== 1) return;
    let samples = new Int16Array(e.data);
    if (needResample) samples = downsampleInt16(samples, ratio);
    solo.audioBatch.push(samples);
    batchSamples += samples.length;
    if (solo.audioBatch.length >= AUDIO_BATCH_FRAMES) {
      const merged = new Int16Array(batchSamples);
      let off = 0;
      for (const b of solo.audioBatch) { merged.set(b, off); off += b.length; }
      solo.audioBatch = [];
      batchSamples = 0;
      try {
        solo.ws.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64FromInt16(merged),
        }));
      } catch {}
    }
  };
  solo.audioSource.connect(solo.audioNode);
  if (ctx.state === 'suspended') await ctx.resume();
}

function sendSoloSession(srcLang, tgtLang, manual) {
  if (!solo.ws || solo.ws.readyState !== 1) return;
  const src = langByCode(srcLang);
  const tgt = langByCode(tgtLang);
  const instructions =
    `You are a professional simultaneous interpreter. ` +
    `Translate the user's ${src.english} utterance into natural, idiomatic ${tgt.english}. ` +
    `Output ONLY the ${tgt.english} translation — no explanations, no source text, no labels. ` +
    `Preserve tone.`;
  // Manual (speak mode): user clicks ⏹ to commit. Auto (listen mode):
  // server VAD segments continuous speech and auto-creates responses.
  const turn_detection = manual ? null : {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 600,
    create_response: true,
  };
  solo.ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      modalities: ['text'],
      instructions,
      input_audio_format: 'pcm16',
      input_audio_transcription: { model: 'gpt-4o-transcribe', language: src.whisper },
      turn_detection,
      temperature: 0.6,
    },
  }));
}

// ---------- Solo mode + sub-state UI ----------

function applySoloMode() {
  const view = $('view-solo');
  view.classList.toggle('mode-listen', solo.mode === 'listen');
  view.classList.toggle('mode-speak', solo.mode === 'speak');
  const toggle = $('soloModeToggle');
  if (toggle) toggle.textContent = solo.mode === 'speak' ? '👂 我要听' : '🗣 我要说';
  updateSoloMainBtn();
  updateSoloHint();
}

function updateSoloMainBtn() {
  const btn = $('soloMainBtn');
  if (!btn) return;
  btn.classList.remove('active', 'ready');
  if (solo.mode === 'speak') {
    if (solo.subState === 'recording') {
      btn.textContent = '⏹ 停止';
      btn.classList.add('active');
    } else if (solo.subState === 'awaiting') {
      btn.textContent = '翻译中…';
      btn.classList.add('active');
    } else if (solo.subState === 'ready') {
      btn.textContent = '🔊 发送给对方';
      btn.classList.add('ready');
    } else {
      btn.textContent = '🎙 开始说话';
    }
  } else { // listen
    if (solo.subState === 'listening') {
      btn.textContent = '⏸ 停止聆听';
      btn.classList.add('active');
    } else {
      btn.textContent = '▶ 开始聆听';
    }
  }
}

function updateSoloHint() {
  const hint = $('soloHint');
  if (!hint) return;
  const my = langByCode(solo.myLang)?.name || '';
  const peer = langByCode(solo.peerLang)?.name || '';
  if (solo.mode === 'speak') {
    if (solo.subState === 'idle') hint.textContent = `按 🎙 说${my}，按 ⏹ 停下检查，按 🔊 让对方听${peer}`;
    else if (solo.subState === 'recording') hint.textContent = `正在录音…说完后按 ⏹`;
    else if (solo.subState === 'awaiting') hint.textContent = `等模型翻译…`;
    else if (solo.subState === 'ready') hint.textContent = `检查无误后按 🔊 让对方听到`;
  } else {
    hint.textContent = solo.subState === 'listening'
      ? `请把手机麦克风冲向对方；对方说${peer}，下方实时显示${my}`
      : `按 ▶ 开始聆听对方说${peer}`;
  }
}

async function onSoloMainClick() {
  if (solo.mode === 'speak') {
    if (solo.subState === 'idle') return startSoloRecording();
    if (solo.subState === 'recording') return stopSoloRecording();
    if (solo.subState === 'ready') return playSoloTranslation();
  } else {
    if (solo.subState === 'idle') return startSoloListening();
    if (solo.subState === 'listening') return stopSoloListening();
  }
}

function onSoloModeToggle() {
  // Toggling cancels whatever's in flight in the current mode.
  cancelSoloTurn();
  solo.mode = solo.mode === 'speak' ? 'listen' : 'speak';
  solo.subState = 'idle';
  setSoloNow('', '', false, false);
  applySoloMode();
}

function cancelSoloTurn() {
  solo.active = false;
  if (solo.ws) { try { solo.ws.close(); } catch {} solo.ws = null; }
  solo.audioBatch = [];
  solo.lastUserItemId = null;
  solo.responseToMsg.clear();
  solo.currentMsgId = null;
}

// ---------- Speak mode (turn-based, manual VAD) ----------

async function startSoloRecording() {
  if (!solo.ticket) return;
  cancelSoloTurn();
  solo.subState = 'recording';
  updateSoloMainBtn();
  updateSoloHint();
  setSoloNow('', '', false, false);

  if (!await openSoloWS()) return;
  if (solo.subState !== 'recording') return;
  sendSoloSession(solo.myLang, solo.peerLang, /*manual*/ true);
  solo.active = true;
}

function stopSoloRecording() {
  solo.active = false;
  flushSoloAudioBatch();
  if (solo.ws && solo.ws.readyState === 1) {
    try {
      solo.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      solo.ws.send(JSON.stringify({ type: 'response.create' }));
    } catch {}
  }
  solo.subState = 'awaiting';
  updateSoloMainBtn();
  updateSoloHint();
}

function playSoloTranslation() {
  const entry = solo.currentMsgId ? solo.messages.get(solo.currentMsgId) : null;
  const text = entry?.translationText || '';
  const lang = entry?.translationLang || '';
  const back = () => {
    solo.subState = 'idle';
    setSoloNow('', '', false, false);
    updateSoloMainBtn();
    updateSoloHint();
  };
  if (!text) { back(); return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (lang) u.lang = lang;
    u.onend = back;
    u.onerror = back;
    speechSynthesis.speak(u);
  } catch {
    back();
  }
}

// ---------- Listen mode (continuous, server VAD auto-segments) ----------

async function startSoloListening() {
  if (!solo.ticket) return;
  cancelSoloTurn();
  solo.subState = 'listening';
  updateSoloMainBtn();
  updateSoloHint();
  setSoloNow('', '', false, false);

  if (!await openSoloWS()) return;
  if (solo.subState !== 'listening') return;
  // In listen mode the device holder is the *listener*; the speaker is the
  // other person, so source = peerLang, target = myLang.
  sendSoloSession(solo.peerLang, solo.myLang, /*manual*/ false);
  solo.active = true;
}

function stopSoloListening() {
  solo.active = false;
  flushSoloAudioBatch();
  // Don't force a final commit here — server VAD will close any in-flight
  // utterance when audio stops, and we don't want a stray empty response.
  if (solo.ws) { try { solo.ws.close(); } catch {} solo.ws = null; }
  solo.subState = 'idle';
  updateSoloMainBtn();
  updateSoloHint();
}

// ---------- Shared helpers ----------

async function openSoloWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/solo/oai?ticket=${encodeURIComponent(solo.ticket)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  solo.ws = ws;
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    handleSoloEvent(ev);
  });
  ws.addEventListener('close', () => { if (solo.ws === ws) solo.ws = null; });
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('Realtime 连接失败')), { once: true });
      ws.addEventListener('close', () => reject(new Error('连接关闭')), { once: true });
    });
    return solo.ws === ws;
  } catch (e) {
    if (solo.ws !== ws) return false;
    solo.ws = null;
    solo.subState = 'idle';
    setSoloNow('连接失败：' + e.message, '', false, false);
    updateSoloMainBtn();
    updateSoloHint();
    return false;
  }
}

function flushSoloAudioBatch() {
  if (!solo.audioBatch.length) return;
  if (!solo.ws || solo.ws.readyState !== 1) { solo.audioBatch = []; return; }
  let total = 0;
  for (const b of solo.audioBatch) total += b.length;
  const merged = new Int16Array(total);
  let off = 0;
  for (const b of solo.audioBatch) { merged.set(b, off); off += b.length; }
  solo.audioBatch = [];
  try {
    solo.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64FromInt16(merged),
    }));
  } catch {}
}

function promoteSoloIfReady(msgId, entry) {
  // Speak mode only: tap-to-send is gated on translation done.
  if (solo.mode !== 'speak') return;
  if (!entry.translationFinal) return;
  if (solo.subState !== 'awaiting') return;
  solo.currentMsgId = msgId;
  solo.subState = 'ready';
  updateSoloMainBtn();
  updateSoloHint();
}

function stopSoloAudio() {
  try { solo.audioSource && solo.audioSource.disconnect(); } catch {}
  try { solo.audioNode && solo.audioNode.disconnect(); } catch {}
  if (solo.audioCtx) { try { solo.audioCtx.close(); } catch {} }
  if (solo.stream) solo.stream.getTracks().forEach((t) => t.stop());
  solo.audioCtx = solo.audioSource = solo.audioNode = solo.stream = null;
  solo.active = false;
}

function leaveSolo() {
  if (solo.ws) { try { solo.ws.close(); } catch {} solo.ws = null; }
  stopSoloAudio();
  resetSoloState();
  showView('view-home');
}

function resetSoloState() {
  solo.messages.clear();
  solo.order.length = 0;
  solo.lastUserItemId = null;
  solo.responseToMsg.clear();
  solo.currentMsgId = null;
  solo.subState = 'idle';
  const h = $('soloHistory'); if (h) h.innerHTML = '';
  setSoloNow('', '', false, false);
  updateSoloMainBtn();
  updateSoloHint();
}

$('soloMainBtn').addEventListener('click', onSoloMainClick);
$('soloModeToggle').addEventListener('click', onSoloModeToggle);
$('soloLeave').addEventListener('click', leaveSolo);
$('soloExport').addEventListener('click', exportSoloConversation);

function handleSoloEvent(ev) {
  switch (ev.type) {
    case 'conversation.item.created':
      if (ev.item && ev.item.role === 'user') {
        solo.lastUserItemId = ev.item.id;
        ensureSoloMsg(ev.item.id);
      }
      break;
    case 'conversation.item.input_audio_transcription.delta':
      updateSoloSource(ev.item_id, ev.delta || '', false, true);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      updateSoloSource(ev.item_id, ev.transcript || '', true, false);
      break;
    case 'response.created':
      if (ev.response?.id && solo.lastUserItemId) {
        solo.responseToMsg.set(ev.response.id, solo.lastUserItemId);
      }
      break;
    case 'response.text.delta':
    case 'response.output_text.delta':
    case 'response.audio_transcript.delta':
    case 'response.output_audio_transcript.delta':
      updateSoloTranslation(ev.response_id, ev.delta || '', false);
      break;
    case 'response.text.done':
    case 'response.output_text.done':
      updateSoloTranslation(ev.response_id, '', true, ev.text || '');
      break;
    case 'response.audio_transcript.done':
    case 'response.output_audio_transcript.done':
      updateSoloTranslation(ev.response_id, '', true, ev.transcript || '');
      break;
    case 'response.done':
      if (ev.response?.output) {
        const text = ev.response.output.flatMap((o) => o.content || [])
          .map((c) => c.text || c.transcript || '').join('');
        if (text) updateSoloTranslation(ev.response.id, '', true, text);
      }
      break;
    case 'error':
      console.error('[solo realtime error]', ev);
      break;
    default:
      if (ev.type && (ev.type.startsWith('response.') || ev.type.includes('error'))) {
        console.debug('[solo realtime]', ev.type, ev);
      }
  }
}

function ensureSoloMsg(msgId) {
  let entry = solo.messages.get(msgId);
  if (entry) return entry;
  // Speak mode: device holder is the speaker → speaker = 'me'.
  // Listen mode: the other person is the speaker → speaker = 'peer'.
  const speaker = solo.mode === 'speak' ? 'me' : 'peer';
  const srcLang = speaker === 'me' ? solo.myLang : solo.peerLang;
  const tgtLang = speaker === 'me' ? solo.peerLang : solo.myLang;
  entry = {
    speaker,
    sourceLang: srcLang, translationLang: tgtLang,
    sourceText: '', translationText: '',
    sourceFinal: false, translationFinal: false,
    ts: Date.now(), historyEl: null,
  };
  solo.messages.set(msgId, entry);
  solo.order.push(msgId);
  return entry;
}

function updateSoloSource(msgId, payload, done, append) {
  const e = ensureSoloMsg(msgId);
  if (done) { e.sourceText = payload; e.sourceFinal = true; }
  else if (append) e.sourceText += payload;
  else e.sourceText = payload;
  paintSoloNow(e);
  maybeArchiveSolo(msgId, e);
}

function updateSoloTranslation(respId, delta, done, fullText) {
  const msgId = solo.responseToMsg.get(respId) || solo.lastUserItemId;
  if (!msgId) return;
  const e = ensureSoloMsg(msgId);
  if (done) {
    if (fullText && fullText.length >= e.translationText.length) e.translationText = fullText;
    e.translationFinal = true;
  } else {
    e.translationText += delta;
  }
  paintSoloNow(e);
  maybeArchiveSolo(msgId, e);
  if (e.translationFinal) promoteSoloIfReady(msgId, e);
}

function paintSoloNow(e) {
  setSoloNow(
    e.sourceText || (e.sourceFinal ? '' : '…'),
    e.translationText || (e.translationFinal ? '' : '…'),
    !e.sourceFinal,
    !e.translationFinal,
  );
}

function setSoloNow(sourceText, translationText, sourceInterim, translationInterim) {
  const srcEl = $('soloNowSource');
  const trEl = $('soloNowTranslation');
  if (srcEl) {
    srcEl.textContent = sourceText;
    srcEl.classList.toggle('interim', !!sourceInterim);
  }
  if (trEl) {
    trEl.textContent = translationText;
    trEl.classList.toggle('interim', !!translationInterim);
  }
}

function maybeArchiveSolo(msgId, e) {
  if (!e.sourceFinal || !e.translationFinal) return;
  if (e.historyEl) return;
  const li = document.createElement('div');
  li.className = 'h-msg';
  li.dataset.msgId = msgId;
  const speakerLabel = e.speaker === 'peer' ? '对方' : '你';
  li.innerHTML =
    `<span class="who">${speakerLabel}</span>` +
    `<span class="h-src">${escapeHtml(e.sourceText)}</span>` +
    `<span class="h-tr">${escapeHtml(e.translationText)}</span>`;
  // Click any history row to replay the translation via the browser's TTS.
  li.addEventListener('click', () => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(e.translationText);
      u.lang = e.translationLang;
      speechSynthesis.speak(u);
    } catch {}
  });
  const list = $('soloHistory');
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
  e.historyEl = li;
}

function exportSoloConversation() {
  const rows = solo.order.map((id) => {
    const e = solo.messages.get(id);
    if (!e) return '';
    const who = e.speaker === 'peer' ? '对方' : '你';
    const t = new Date(e.ts).toLocaleTimeString();
    return `<div class="m"><div class="h"><b>${who}</b> <span class="t">${t}</span></div>
      <div class="s">${escapeHtml(e.sourceText)}</div>
      <div class="r">${escapeHtml(e.translationText)}</div></div>`;
  }).join('');
  const stamp = new Date().toLocaleString();
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>单机对话记录 ${stamp}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#111;max-width:780px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.2rem;margin:0 0 1rem}.meta{color:#666;font-size:.85rem;margin-bottom:1.5rem}
.m{padding:.6rem 0;border-bottom:1px solid #eee}.h{font-size:.85rem;color:#555;margin-bottom:.3rem}
.h .t{margin-left:.5rem;color:#999;font-weight:400}.s,.r{margin:.15rem 0;line-height:1.5}
.s{color:#111}.r{color:#0050a0}@media print{body{margin:1cm}.m{break-inside:avoid}}
</style></head><body><h1>单机翻译对话记录</h1>
<div class="meta">导出时间：${stamp} · 共 ${solo.order.length} 条</div>
${rows || '<p style="color:#666">这次对话没有任何记录。</p>'}
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('浏览器拦截了弹窗，无法导出。请允许此站点弹窗后重试。'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

// ---------- Interview mode (single device, stereo wireless mic) ----------

const interview = {
  ticket: null,
  leftLang: 'zh',
  rightLang: 'en',
  audioCtx: null, stream: null, splitter: null,
  leftWorklet: null, rightWorklet: null,
  active: false,
  lanes: {
    left:  { ws: null, lastUserItemId: null, responseToMsg: new Map(),
             messages: new Map(), order: [], audioBatch: [] },
    right: { ws: null, lastUserItemId: null, responseToMsg: new Map(),
             messages: new Map(), order: [], audioBatch: [] },
  },
};

fillLangSelect($('ivLeftLang'), 'zh');
fillLangSelect($('ivRightLang'), 'en');

$('goInterview').onclick = () => { showView('view-interview-form'); };

$('interviewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sitePassword = $('ivPwd').value;
  const leftLang = $('ivLeftLang').value;
  const rightLang = $('ivRightLang').value;
  if (leftLang === rightLang) { showErr('ivErr', '两边的语言不能相同'); return; }
  $('ivErr').hidden = true;
  $('ivBtn').disabled = true;
  try { await startInterview(sitePassword, leftLang, rightLang); }
  catch (err) { showErr('ivErr', err.message || String(err)); }
  finally { $('ivBtn').disabled = false; }
});

async function startInterview(sitePassword, leftLang, rightLang) {
  // 1. Exchange password for ticket.
  const resp = await fetch('/api/solo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sitePassword }),
  });
  let data = null; try { data = await resp.json(); } catch {}
  if (!resp.ok) {
    throw new Error(data?.error === 'bad_site_password' ? '创建密码错误' : (data?.error || '失败'));
  }
  interview.ticket = data.ticket;
  interview.leftLang = leftLang;
  interview.rightLang = rightLang;

  // 2. Open the mic in stereo. We need raw channels — disable AEC / NS /
  //    AGC, which on most browsers would downmix to mono internally.
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: SAMPLE_RATE,
      },
    });
  } catch (err) {
    throw new Error('无法访问麦克风：' + (err.message || err));
  }
  interview.stream = stream;
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  const channelCount = settings.channelCount || 1;
  if (channelCount < 2) {
    cleanupInterviewAudio();
    throw new Error(
      '当前麦克风只有 1 个声道（' + (track.label || '默认输入') + '）。' +
      '请连接双发射器无线麦的接收器，并把它设为双轨 / Discrete 输出。'
    );
  }

  // 3. Split stereo input into two mono PCM streams via two AudioWorklets.
  let ctx;
  try { ctx = new AudioContext({ sampleRate: SAMPLE_RATE }); }
  catch { ctx = new AudioContext(); }
  interview.audioCtx = ctx;
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const splitter = ctx.createChannelSplitter(2);
  source.connect(splitter);
  interview.splitter = splitter;

  const needResample = ctx.sampleRate !== SAMPLE_RATE;
  const ratio = ctx.sampleRate / SAMPLE_RATE;

  const makeWorklet = (channelIdx, side) => {
    const node = new AudioWorkletNode(ctx, 'pcm16', {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete',
    });
    splitter.connect(node, channelIdx);
    node.port.onmessage = (e) => onInterviewPcm(side, e.data, needResample, ratio);
    return node;
  };
  interview.leftWorklet  = makeWorklet(0, 'left');
  interview.rightWorklet = makeWorklet(1, 'right');

  // 4. Open both Realtime lanes — server VAD on both for continuous flow.
  await Promise.all([
    openInterviewLane('left',  leftLang,  rightLang),
    openInterviewLane('right', rightLang, leftLang),
  ]);

  if (ctx.state === 'suspended') await ctx.resume();
  interview.active = true;

  $('ivLeftLangName').textContent  = langByCode(leftLang).name;
  $('ivRightLangName').textContent = langByCode(rightLang).name;
  setIvNow('left',  '', '', false, false);
  setIvNow('right', '', '', false, false);
  $('ivLeftHistory').innerHTML = '';
  $('ivRightHistory').innerHTML = '';
  setIvStatus('采访中', '');
  showView('view-interview');
}

function onInterviewPcm(side, buf, needResample, ratio) {
  const lane = interview.lanes[side];
  if (!interview.active || !lane.ws || lane.ws.readyState !== 1) return;
  let samples = new Int16Array(buf);
  if (needResample) samples = downsampleInt16(samples, ratio);
  lane.audioBatch.push(samples);
  if (lane.audioBatch.length >= AUDIO_BATCH_FRAMES) flushInterviewBatch(side);
}

function flushInterviewBatch(side) {
  const lane = interview.lanes[side];
  if (!lane.audioBatch.length) return;
  if (!lane.ws || lane.ws.readyState !== 1) { lane.audioBatch = []; return; }
  let total = 0;
  for (const b of lane.audioBatch) total += b.length;
  const merged = new Int16Array(total);
  let off = 0;
  for (const b of lane.audioBatch) { merged.set(b, off); off += b.length; }
  lane.audioBatch = [];
  try {
    lane.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64FromInt16(merged),
    }));
  } catch {}
}

async function openInterviewLane(side, srcLang, tgtLang) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/solo/oai?ticket=${encodeURIComponent(interview.ticket)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  interview.lanes[side].ws = ws;

  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    handleInterviewEvent(side, ev);
  });
  ws.addEventListener('close', () => {
    if (interview.lanes[side].ws === ws) interview.lanes[side].ws = null;
    if (interview.active) setIvStatus(side === 'left' ? '左路连接断开' : '右路连接断开', 'err');
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(side + ' WS 连接失败')), { once: true });
  });

  const src = langByCode(srcLang);
  const tgt = langByCode(tgtLang);
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      modalities: ['text'],
      instructions:
        `You are a professional simultaneous interpreter. ` +
        `Translate the user's ${src.english} utterance into natural, idiomatic ${tgt.english}. ` +
        `Output ONLY the ${tgt.english} translation — no explanations, no source text, no labels. ` +
        `Preserve tone.`,
      input_audio_format: 'pcm16',
      input_audio_transcription: { model: 'gpt-4o-transcribe', language: src.whisper },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
        create_response: true,
      },
      temperature: 0.6,
    },
  }));
}

function handleInterviewEvent(side, ev) {
  const lane = interview.lanes[side];
  switch (ev.type) {
    case 'conversation.item.created':
      if (ev.item && ev.item.role === 'user') {
        lane.lastUserItemId = ev.item.id;
        ensureIvMsg(side, ev.item.id);
      }
      break;
    case 'conversation.item.input_audio_transcription.delta':
      updateIvSource(side, ev.item_id, ev.delta || '', false, true);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      updateIvSource(side, ev.item_id, ev.transcript || '', true, false);
      break;
    case 'response.created':
      if (ev.response?.id && lane.lastUserItemId) {
        lane.responseToMsg.set(ev.response.id, lane.lastUserItemId);
      }
      break;
    case 'response.text.delta':
    case 'response.output_text.delta':
    case 'response.audio_transcript.delta':
    case 'response.output_audio_transcript.delta':
      updateIvTranslation(side, ev.response_id, ev.delta || '', false);
      break;
    case 'response.text.done':
    case 'response.output_text.done':
      updateIvTranslation(side, ev.response_id, '', true, ev.text || '');
      break;
    case 'response.audio_transcript.done':
    case 'response.output_audio_transcript.done':
      updateIvTranslation(side, ev.response_id, '', true, ev.transcript || '');
      break;
    case 'error':
      console.error('[interview ' + side + ']', ev);
      setIvStatus('错误: ' + (ev.error?.message || 'unknown'), 'err');
      break;
    default:
      if (ev.type && ev.type.includes('error')) console.debug('[interview ' + side + ']', ev.type, ev);
  }
}

function ensureIvMsg(side, msgId) {
  const lane = interview.lanes[side];
  let e = lane.messages.get(msgId);
  if (e) return e;
  const srcLang = side === 'left' ? interview.leftLang : interview.rightLang;
  const tgtLang = side === 'left' ? interview.rightLang : interview.leftLang;
  e = {
    side, sourceLang: srcLang, translationLang: tgtLang,
    sourceText: '', translationText: '',
    sourceFinal: false, translationFinal: false,
    ts: Date.now(), historyEl: null,
  };
  lane.messages.set(msgId, e);
  lane.order.push(msgId);
  return e;
}

function updateIvSource(side, msgId, payload, done, append) {
  const e = ensureIvMsg(side, msgId);
  if (done) { e.sourceText = payload; e.sourceFinal = true; }
  else if (append) e.sourceText += payload;
  else e.sourceText = payload;
  paintIvNow(side, e);
  maybeArchiveIv(side, msgId, e);
}

function updateIvTranslation(side, respId, delta, done, fullText) {
  const lane = interview.lanes[side];
  const msgId = lane.responseToMsg.get(respId) || lane.lastUserItemId;
  if (!msgId) return;
  const e = ensureIvMsg(side, msgId);
  if (done) {
    if (fullText && fullText.length >= e.translationText.length) e.translationText = fullText;
    e.translationFinal = true;
  } else {
    e.translationText += delta;
  }
  paintIvNow(side, e);
  maybeArchiveIv(side, msgId, e);
}

function paintIvNow(side, e) {
  setIvNow(side,
    e.sourceText || (e.sourceFinal ? '' : '…'),
    e.translationText || (e.translationFinal ? '' : '…'),
    !e.sourceFinal, !e.translationFinal);
}

function setIvNow(side, sourceText, translationText, sourceInterim, translationInterim) {
  const cap = side === 'left' ? 'Left' : 'Right';
  const s = $('iv' + cap + 'Source');
  const t = $('iv' + cap + 'Translation');
  if (s) { s.textContent = sourceText; s.classList.toggle('interim', !!sourceInterim); }
  if (t) { t.textContent = translationText; t.classList.toggle('interim', !!translationInterim); }
}

function maybeArchiveIv(side, msgId, e) {
  if (!e.sourceFinal || !e.translationFinal) return;
  if (e.historyEl) return;
  const row = document.createElement('div');
  row.className = 'h-row';
  row.innerHTML =
    `<span class="h-src">${escapeHtml(e.sourceText)}</span>` +
    `<span class="h-tr">${escapeHtml(e.translationText)}</span>`;
  const list = $('iv' + (side === 'left' ? 'Left' : 'Right') + 'History');
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  e.historyEl = row;
  // Now-pane clears to make room for the next utterance.
  setIvNow(side, '', '', false, false);
}

function setIvStatus(text, cls) {
  const el = $('ivStatus');
  el.textContent = text;
  el.className = 'iv-status' + (cls ? ' ' + cls : '');
}

function cleanupInterviewAudio() {
  try { interview.splitter && interview.splitter.disconnect(); } catch {}
  try { interview.leftWorklet && interview.leftWorklet.disconnect(); } catch {}
  try { interview.rightWorklet && interview.rightWorklet.disconnect(); } catch {}
  if (interview.audioCtx) { try { interview.audioCtx.close(); } catch {} }
  if (interview.stream) interview.stream.getTracks().forEach((t) => t.stop());
  interview.audioCtx = interview.splitter = interview.leftWorklet = interview.rightWorklet = null;
  interview.stream = null;
}

function leaveInterview() {
  interview.active = false;
  for (const side of ['left', 'right']) {
    const lane = interview.lanes[side];
    if (lane.ws) { try { lane.ws.close(); } catch {} lane.ws = null; }
    lane.audioBatch = [];
  }
  cleanupInterviewAudio();
  showView('view-home');
}

function exportInterviewConversation() {
  // Merge both lanes by timestamp.
  const all = [];
  for (const side of ['left', 'right']) {
    const lane = interview.lanes[side];
    for (const id of lane.order) {
      const e = lane.messages.get(id);
      if (e) all.push(e);
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  const rows = all.map((e) => {
    const who = e.side === 'left' ? '左' : '右';
    const t = new Date(e.ts).toLocaleTimeString();
    return `<div class="m"><div class="h"><b>${who}</b> <span class="t">${t}</span></div>
      <div class="s">${escapeHtml(e.sourceText)}</div>
      <div class="r">${escapeHtml(e.translationText)}</div></div>`;
  }).join('');
  const stamp = new Date().toLocaleString();
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>双人采访记录 ${stamp}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#111;max-width:780px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.2rem;margin:0 0 1rem}.meta{color:#666;font-size:.85rem;margin-bottom:1.5rem}
.m{padding:.6rem 0;border-bottom:1px solid #eee}.h{font-size:.85rem;color:#555;margin-bottom:.3rem}
.h .t{margin-left:.5rem;color:#999;font-weight:400}.s,.r{margin:.15rem 0;line-height:1.5}
.s{color:#111}.r{color:#0050a0}@media print{body{margin:1cm}.m{break-inside:avoid}}
</style></head><body><h1>双人采访记录</h1>
<div class="meta">导出时间：${stamp} · 共 ${all.length} 条</div>
${rows || '<p style="color:#666">这次采访没有任何记录。</p>'}
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('浏览器拦截了弹窗，无法导出。请允许此站点弹窗后重试。'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

$('ivLeave').addEventListener('click', leaveInterview);
$('ivExport').addEventListener('click', exportInterviewConversation);

window.addEventListener('beforeunload', () => { leaveRoom(); leaveInterview(); });
