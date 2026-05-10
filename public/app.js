// 1-to-1 realtime interpreter client.
//
// Architecture:
//   - Browser <—WS—> Cloudflare Worker Durable Object (auth, ephemeral token, peer relay)
//   - Browser <—WebRTC—> OpenAI Realtime API (mic in, translated text out)
//   - My WebRTC session is configured to translate MY language into PEER's language.
//     The translated text stream is forwarded over WS to the peer, who renders it.

const LANGS = [
  { code: 'zh', name: '中文',     english: 'Chinese',  whisper: 'zh' },
  { code: 'en', name: 'English',  english: 'English',  whisper: 'en' },
  { code: 'ja', name: '日本語',   english: 'Japanese', whisper: 'ja' },
  { code: 'de', name: 'Deutsch',  english: 'German',   whisper: 'de' },
  { code: 'ru', name: 'Русский',  english: 'Russian',  whisper: 'ru' },
  { code: 'fr', name: 'Français', english: 'French',   whisper: 'fr' },
];

const $ = (id) => document.getElementById(id);
const langByCode = (c) => LANGS.find((l) => l.code === c) || LANGS[0];

const prefs = {
  myLang: localStorage.getItem('rti_my_lang') || 'zh',
  model:  localStorage.getItem('rti_model')   || 'gpt-4o-realtime-preview',
};

const room = {
  id: null,
  password: '',
  ws: null,
  role: null,
  peerPresent: false,
  peerLanguage: null,
  myLanguage: prefs.myLang,
  model: prefs.model,
  ephemeral: null,
  // WebRTC
  pc: null,
  dc: null,
  stream: null,
  rtcReady: false,
  // Rendering state
  outgoingLines: new Map(), // userItemId -> { el, text, done }
  outgoingResponses: new Map(), // responseId -> { el, text, sentLen, done }
  incomingLines: new Map(), // remoteSubtitleId -> { el, text }
  lastUserItemId: null,
  // Bookkeeping
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

// ---------- Populate language selects ----------

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

// ---------- Create / Join forms ----------

$('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey   = $('createKey').value.trim();
  const password = $('createPwd').value;
  const model    = $('createModel').value.trim() || 'gpt-4o-realtime-preview';
  const myLang   = $('createLang').value;
  if (!apiKey.startsWith('sk-')) {
    showCreateErr('请提供以 sk- 开头的 OpenAI API key。');
    return;
  }
  $('createBtn').disabled = true;
  try {
    const resp = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey, password, model }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'create failed');
    localStorage.setItem('rti_my_lang', myLang);
    localStorage.setItem('rti_model', model);
    enterRoom(data.roomId, password, myLang, model);
  } catch (err) {
    showCreateErr(err.message || String(err));
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
  enterRoom(id, pwd, myLang, prefs.model);
});

function showCreateErr(msg) { const el = $('createErr'); el.textContent = msg; el.hidden = false; }
function showJoinErr(msg)   { const el = $('joinErr');   el.textContent = msg; el.hidden = false; }

// ---------- Room view ----------

function enterRoom(roomId, password, myLang, model) {
  room.id = roomId;
  room.password = password;
  room.myLanguage = myLang;
  room.model = model;
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
  if (!language) {
    el.textContent = '对方未到';
    el.classList.remove('connected');
  } else {
    el.textContent = `对方说 ${langByCode(language).name}`;
    el.classList.add('connected');
  }
}

function resetLines() {
  $('incoming').innerHTML = '';
  $('outgoing').innerHTML = '';
  room.outgoingLines.clear();
  room.outgoingResponses.clear();
  room.incomingLines.clear();
  room.lastUserItemId = null;
}

$('myLang').addEventListener('change', () => {
  room.myLanguage = $('myLang').value;
  localStorage.setItem('rti_my_lang', room.myLanguage);
  if (room.ws && room.ws.readyState === 1) {
    room.ws.send(JSON.stringify({ type: 'set_language', language: room.myLanguage }));
  }
  // Reconfigure the realtime session if active.
  if (room.dc && room.dc.readyState === 'open') sendSessionUpdate();
});

$('copyRoom').onclick = async () => {
  try { await navigator.clipboard.writeText(room.id); setStatus('房间号已复制', 'live'); }
  catch { /* ignore */ }
};

$('leaveBtn').onclick = () => { leaveRoom(); showView('view-home'); };

$('micBtn').onclick = async () => {
  if (room.micEnabled) { stopMic(); return; }
  if (!room.peerPresent) { setStatus('请等对方加入', 'warn'); return; }
  if (!room.ephemeral) { setStatus('凭证未就绪', 'err'); return; }
  try { await startMic(); }
  catch (err) {
    console.error(err);
    setStatus('错误: ' + (err.message || err), 'err');
    stopMic();
  }
};

// ---------- WebSocket signaling ----------

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
      room.ephemeral = msg.ephemeral;
      setPeerLabel(room.peerLanguage);
      setStatus(room.peerPresent ? '已就绪' : '等待对方加入…', room.peerPresent ? 'live' : 'warn');
      break;
    case 'peer_joined':
      room.peerPresent = true;
      room.peerLanguage = msg.language;
      setPeerLabel(room.peerLanguage);
      setStatus('已就绪', 'live');
      // If mic is on, reconfigure session for the new peer language.
      if (room.dc && room.dc.readyState === 'open') sendSessionUpdate();
      break;
    case 'peer_language':
      room.peerLanguage = msg.language;
      setPeerLabel(room.peerLanguage);
      if (room.dc && room.dc.readyState === 'open') sendSessionUpdate();
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
    case 'ephemeral':
      room.ephemeral = msg.ephemeral;
      break;
    case 'error':
      if (msg.error === 'bad_password') {
        setStatus('密码错误', 'err');
        showJoinErr('房间密码错误');
        leaveRoom();
        showView('view-join');
      } else if (msg.error === 'room_full') {
        setStatus('房间已满', 'err');
        showJoinErr('该房间已有两人在线');
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
  room.ephemeral = null;
}

// ---------- Realtime / WebRTC ----------

function buildInstructions() {
  const src = langByCode(room.myLanguage);
  const tgt = langByCode(room.peerLanguage || room.myLanguage);
  return (
    `You are a professional simultaneous interpreter. ` +
    `The user speaks ${src.english}. ` +
    `Translate every utterance into natural, idiomatic ${tgt.english}. ` +
    `Output ONLY the ${tgt.english} translation — no explanations, no source text, ` +
    `no quotation marks, no language labels. ` +
    `Preserve the speaker's tone (casual stays casual, formal stays formal). ` +
    `Begin emitting translation as soon as enough has been said; do not wait for the full sentence. ` +
    `Keep proper nouns and well-known technical terms in their conventional form.`
  );
}

function buildSessionConfig() {
  const src = langByCode(room.myLanguage);
  return {
    modalities: ['text'],
    instructions: buildInstructions(),
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
  if (!room.dc || room.dc.readyState !== 'open') return;
  room.dc.send(JSON.stringify({ type: 'session.update', session: buildSessionConfig() }));
}

async function startMic() {
  setStatus('请求麦克风…');
  room.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const pc = new RTCPeerConnection();
  room.pc = pc;
  pc.ontrack = () => {}; // text-only

  pc.addTrack(room.stream.getAudioTracks()[0], room.stream);

  const dc = pc.createDataChannel('oai-events');
  room.dc = dc;
  dc.addEventListener('open', () => {
    sendSessionUpdate();
    room.rtcReady = true;
    setStatus('已连接 · 正在聆听', 'live');
    room.micEnabled = true;
    $('micBtn').textContent = '停止';
    $('micBtn').classList.add('recording');
    $('micBtn').classList.remove('primary');
  });
  dc.addEventListener('message', (e) => {
    try { handleRealtimeEvent(JSON.parse(e.data)); } catch {}
  });

  pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      if (room.pc === pc) stopMic();
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  setStatus('连接 OpenAI…');
  const clientSecret = room.ephemeral?.client_secret?.value;
  if (!clientSecret) throw new Error('missing ephemeral client secret');
  const model = room.ephemeral?.model || room.model;
  const resp = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      'Content-Type': 'application/sdp',
    },
    body: offer.sdp,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${body.slice(0, 200)}`);
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() });
}

function stopMic() {
  room.rtcReady = false;
  room.micEnabled = false;
  try { room.dc && room.dc.close(); } catch {}
  try { room.pc && room.pc.close(); } catch {}
  if (room.stream) room.stream.getTracks().forEach((t) => t.stop());
  room.pc = room.dc = room.stream = null;
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

// Render the user's own transcript (what I'm saying, in my language).
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

// Render the model's translation (what I'm sending out) and forward to peer.
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
  // Forward only new content to peer, as streaming subtitles.
  if (room.ws && room.ws.readyState === 1) {
    if (row.text.length > row.sentLen || done) {
      const payload = {
        type: 'subtitle',
        id: 'r_' + responseId,
        text: row.text,
        final: !!done,
      };
      room.ws.send(JSON.stringify(payload));
      row.sentLen = row.text.length;
    }
  }
  scrollBottom($('outgoing'));
}

// Render incoming subtitles (peer speaking, in my language).
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

// Soft cleanup on tab close.
window.addEventListener('beforeunload', () => { leaveRoom(); });
