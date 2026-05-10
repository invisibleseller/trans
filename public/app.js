// 1-to-1 realtime interpreter client.
//
// Browser <—WS—> Cloudflare Worker:
//   /api/rooms/:id/ws   room signaling, peer subtitle relay, quota updates
//   /api/rooms/:id/oai  reverse proxy to OpenAI Realtime over WebSocket
//
// All audio leaves the browser as base64 PCM16 @ 24 kHz over the proxy WS.
// No direct connection to api.openai.com is required from the browser.

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
const AUDIO_BATCH_FRAMES = 8;       // ~43 ms per outgoing chunk @ 24 kHz

const $ = (id) => document.getElementById(id);
const langByCode = (c) => LANGS.find((l) => l.code === c) || LANGS[0];

const prefs = {
  myLang: localStorage.getItem('rti_my_lang') || 'zh',
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
  trialSeconds: 30,
  usedBytes: 0,

  // Realtime proxy WS + audio pipeline
  oai: null,
  audioCtx: null,
  audioSource: null,
  audioNode: null,
  stream: null,
  audioBatch: [],

  // UI rendering state
  outgoingLines: new Map(),       // userItemId -> { el, text, done }
  outgoingResponses: new Map(),   // responseId -> { el, text, sentLen, done }
  incomingLines: new Map(),       // subtitleId -> { el }
  lastUserItemId: null,

  micEnabled: false,
};

// ---------- View routing ----------

function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
  $(id).classList.add('active');
}
document.querySelectorAll('[data-back]').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); showView('view-home'); });
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

// ---------- Create / Join ----------

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

// ---------- Room view ----------

function enterRoom(roomId, password, myLang) {
  room.id = roomId;
  room.password = password;
  room.myLanguage = myLang;
  $('roomCode').textContent = roomId;
  $('myLang').value = myLang;
  setStatus('连接房间…');
  setPeerLabel(null);
  resetLines();
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
function resetLines() {
  $('incoming').innerHTML = '';
  $('outgoing').innerHTML = '';
  room.outgoingLines.clear();
  room.outgoingResponses.clear();
  room.incomingLines.clear();
  room.lastUserItemId = null;
}
function bytesToSeconds(b) { return b / (SAMPLE_RATE * BYTES_PER_SAMPLE); }
function updateQuotaUI() {
  const totalSec = room.trialSeconds;
  const usedSec = bytesToSeconds(room.usedBytes);
  const remaining = Math.max(0, totalSec - usedSec);
  const el = $('quota');
  el.textContent = `试用 ${remaining.toFixed(1)}s / ${totalSec}s`;
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
$('leaveBtn').onclick = () => { leaveRoom(); showView('view-home'); };
$('micBtn').onclick = async () => {
  if (room.micEnabled) { stopMic(); return; }
  if (!room.peerPresent) { setStatus('请等对方加入', 'warn'); return; }
  if (bytesToSeconds(room.usedBytes) >= room.trialSeconds) {
    setStatus('试用额度已用完', 'err');
    return;
  }
  try { await startMic(); }
  catch (err) {
    console.error(err);
    setStatus('错误: ' + (err.message || err), 'err');
    stopMic();
  }
};

// ---------- Signaling WS ----------

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
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
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
      room.trialSeconds = Number(msg.trialSeconds || 30);
      room.usedBytes = Number(msg.usedBytes || 0);
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
      room.usedBytes = Number(msg.usedBytes || room.usedBytes);
      updateQuotaUI();
      break;
    case 'quota_exceeded':
      room.usedBytes = Number(msg.usedBytes || room.usedBytes);
      updateQuotaUI();
      setStatus('试用额度已用完', 'err');
      stopMic();
      break;
    case 'error':
      if (msg.error === 'bad_password') {
        showErr('joinErr', '房间密码错误');
        leaveRoom();
        showView('view-join');
      } else if (msg.error === 'room_full') {
        showErr('joinErr', '该房间已有两人在线');
        leaveRoom();
        showView('view-join');
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

// ---------- Realtime over WS proxy + AudioWorklet ----------

function buildInstructions() {
  const src = langByCode(room.myLanguage);
  const tgt = langByCode(room.peerLanguage || room.myLanguage);
  return (
    `You are a professional simultaneous interpreter. ` +
    `The user speaks ${src.english}. ` +
    `Translate every utterance into natural, idiomatic ${tgt.english}. ` +
    `Output ONLY the ${tgt.english} translation — no explanations, no source text, ` +
    `no quotation marks, no language labels. ` +
    `Preserve the speaker's tone. ` +
    `Begin emitting translation as soon as enough has been said; do not wait for the full sentence. ` +
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
    let timer = setTimeout(() => reject(new Error('ticket timeout')), 3000);
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
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
    },
  });

  await ensureTicket();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ticket = room.ticket;
  room.ticket = null; // consumed
  const oaiUrl = `${proto}//${location.host}/api/rooms/${encodeURIComponent(room.id)}/oai?ticket=${encodeURIComponent(ticket)}`;

  setStatus('连接 Realtime…');
  const oai = new WebSocket(oaiUrl);
  oai.binaryType = 'arraybuffer';
  room.oai = oai;

  await new Promise((resolve, reject) => {
    const onOpen = () => { oai.removeEventListener('open', onOpen); resolve(); };
    const onErr = () => { reject(new Error('proxy ws failed')); };
    oai.addEventListener('open', onOpen);
    oai.addEventListener('error', onErr, { once: true });
  });

  sendSessionUpdate();

  oai.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    handleRealtimeEvent(ev);
  });
  oai.addEventListener('close', () => stopMic());

  // Audio pipeline. AudioContext sample rate falls back to whatever the
  // browser actually gives us; we resample if needed.
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  } catch {
    ctx = new AudioContext();
  }
  room.audioCtx = ctx;
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  room.audioSource = ctx.createMediaStreamSource(room.stream);
  room.audioNode = new AudioWorkletNode(ctx, 'pcm16');

  const needResample = ctx.sampleRate !== SAMPLE_RATE;
  const ratio = ctx.sampleRate / SAMPLE_RATE;
  let resampleCarry = 0;

  room.audioBatch = [];
  let batchSamples = 0;

  room.audioNode.port.onmessage = (e) => {
    if (!room.oai || room.oai.readyState !== 1) return;

    let samples = new Int16Array(e.data);
    if (needResample) {
      samples = downsampleInt16(samples, ratio, resampleCarryRef);
    }

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
  // Intentionally do not connect to ctx.destination — we don't want to hear
  // our own voice routed back out.
  if (ctx.state === 'suspended') await ctx.resume();

  room.micEnabled = true;
  $('micBtn').textContent = '停止';
  $('micBtn').classList.add('recording');
  $('micBtn').classList.remove('primary');
  setStatus('正在聆听', 'live');
}

const resampleCarryRef = { remainder: 0 };

function downsampleInt16(input, ratio, carry) {
  // Simple nearest-neighbor resample. Good enough for speech-to-text.
  if (ratio === 1) return input;
  const outLen = Math.floor((input.length - carry.remainder) / ratio);
  if (outLen <= 0) {
    carry.remainder -= input.length;
    if (carry.remainder < 0) carry.remainder = 0;
    return new Int16Array(0);
  }
  const out = new Int16Array(outLen);
  let srcIdx = carry.remainder;
  for (let i = 0; i < outLen; i++) {
    out[i] = input[Math.floor(srcIdx)];
    srcIdx += ratio;
  }
  carry.remainder = srcIdx - input.length;
  if (carry.remainder < 0) carry.remainder = 0;
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

// ---------- Realtime event → UI + relay ----------

function handleRealtimeEvent(ev) {
  switch (ev.type) {
    case 'conversation.item.created':
      if (ev.item && ev.item.role === 'user') {
        room.lastUserItemId = ev.item.id;
        ensureOutgoingSelfLine(ev.item.id);
      }
      break;
    case 'conversation.item.input_audio_transcription.delta':
      appendOutgoingSelf(ev.item_id, ev.delta || '', false);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      appendOutgoingSelf(ev.item_id, ev.transcript || '', true);
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

function ensureOutgoingSelfLine(itemId) {
  let row = room.outgoingLines.get(itemId);
  if (!row) {
    const el = document.createElement('div');
    el.className = 'line interim';
    $('outgoing').appendChild(el);
    row = { el, text: '', done: false };
    room.outgoingLines.set(itemId, row);
  }
  return row;
}
function appendOutgoingSelf(itemId, deltaOrFull, done) {
  const row = ensureOutgoingSelfLine(itemId);
  if (done) { row.text = deltaOrFull; row.done = true; row.el.classList.remove('interim'); }
  else { row.text += deltaOrFull; }
  row.el.textContent = row.text || '…';
  scrollBottom($('outgoing'));
}

function handleResponseDelta(responseId, delta, done, fullText) {
  let row = room.outgoingResponses.get(responseId);
  if (!row) {
    row = { text: '', sentLen: 0, done: false };
    room.outgoingResponses.set(responseId, row);
  }
  if (done) {
    if (fullText && fullText.length > row.text.length) row.text = fullText;
    row.done = true;
  } else {
    row.text += delta;
  }
  if (room.ws && room.ws.readyState === 1) {
    if (row.text.length > row.sentLen || done) {
      room.ws.send(JSON.stringify({
        type: 'subtitle',
        id: 'r_' + responseId,
        text: row.text,
        final: !!done,
      }));
      row.sentLen = row.text.length;
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
