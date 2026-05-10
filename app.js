// Real-time simultaneous interpretation via OpenAI Realtime API (WebRTC).
// All connection state is held in `state`. UI shows source transcript on the
// left and the translated stream on the right.

const LANGS = [
  { code: 'zh', name: '中文',     english: 'Chinese',  whisper: 'zh' },
  { code: 'en', name: 'English',  english: 'English',  whisper: 'en' },
  { code: 'ja', name: '日本語',   english: 'Japanese', whisper: 'ja' },
  { code: 'de', name: 'Deutsch',  english: 'German',   whisper: 'de' },
  { code: 'ru', name: 'Русский',  english: 'Russian',  whisper: 'ru' },
  { code: 'fr', name: 'Français', english: 'French',   whisper: 'fr' },
];

const $ = (id) => document.getElementById(id);

const state = {
  pc: null,
  dc: null,
  stream: null,
  sessionReady: false,
  // itemId -> { el, text, done }
  srcItems: new Map(),
  // responseId -> { el, text, done }
  tgtItems: new Map(),
  // Map responseId -> the userItemId that triggered it (best-effort pairing)
  pairing: new Map(),
  lastUserItemId: null,
};

const settings = {
  apiKey:       localStorage.getItem('oai_api_key')      || '',
  model:        localStorage.getItem('oai_model')        || 'gpt-4o-realtime-preview',
  instructions: localStorage.getItem('oai_instructions') || '',
  srcLang:      localStorage.getItem('oai_src_lang')     || 'zh',
  tgtLang:      localStorage.getItem('oai_tgt_lang')     || 'en',
};

// ---------- UI wiring ----------

function populateLangSelects() {
  for (const sel of [$('srcLang'), $('tgtLang')]) {
    sel.innerHTML = '';
    for (const l of LANGS) {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.name;
      sel.appendChild(opt);
    }
  }
  $('srcLang').value = settings.srcLang;
  $('tgtLang').value = settings.tgtLang;
  updatePaneHeads();
}

function updatePaneHeads() {
  const src = LANGS.find(l => l.code === settings.srcLang);
  const tgt = LANGS.find(l => l.code === settings.tgtLang);
  $('srcHead').textContent = `${src.name}（识别）`;
  $('tgtHead').textContent = `${tgt.name}（译文）`;
  document.title = `${src.name} → ${tgt.name} 实时同传`;
}

function onLangChange() {
  // If src === tgt, auto-swap the other side to a different language.
  if ($('srcLang').value === $('tgtLang').value) {
    const fallback = LANGS.find(l => l.code !== $('srcLang').value).code;
    if (this && this.id === 'srcLang') $('tgtLang').value = fallback;
    else $('srcLang').value = fallback;
  }
  settings.srcLang = $('srcLang').value;
  settings.tgtLang = $('tgtLang').value;
  localStorage.setItem('oai_src_lang', settings.srcLang);
  localStorage.setItem('oai_tgt_lang', settings.tgtLang);
  updatePaneHeads();
  // If a session is live, push the new config.
  if (state.sessionReady) sendSessionUpdate();
}

$('srcLang').addEventListener('change', onLangChange);
$('tgtLang').addEventListener('change', onLangChange);

$('swapBtn').addEventListener('click', () => {
  const a = $('srcLang').value;
  $('srcLang').value = $('tgtLang').value;
  $('tgtLang').value = a;
  onLangChange();
});

// Settings dialog
$('settingsBtn').addEventListener('click', () => {
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('instructions').value = settings.instructions;
  $('settings').showModal();
});
$('cancelBtn').addEventListener('click', () => $('settings').close());
$('settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  settings.apiKey       = $('apiKey').value.trim();
  settings.model        = $('model').value.trim() || 'gpt-4o-realtime-preview';
  settings.instructions = $('instructions').value.trim();
  localStorage.setItem('oai_api_key', settings.apiKey);
  localStorage.setItem('oai_model', settings.model);
  localStorage.setItem('oai_instructions', settings.instructions);
  $('settings').close();
  if (state.sessionReady) sendSessionUpdate();
});

$('clearBtn').addEventListener('click', () => {
  $('src').innerHTML = '';
  $('tgt').innerHTML = '';
  state.srcItems.clear();
  state.tgtItems.clear();
  state.pairing.clear();
  state.lastUserItemId = null;
});

$('micBtn').addEventListener('click', async () => {
  if (state.pc) { stop(); return; }
  if (!settings.apiKey) { $('settings').showModal(); return; }
  try {
    await start();
  } catch (err) {
    console.error(err);
    setStatus('错误: ' + (err.message || err), 'err');
    stop();
  }
});

populateLangSelects();

// ---------- Prompts ----------

function buildInstructions() {
  const src = LANGS.find(l => l.code === settings.srcLang);
  const tgt = LANGS.find(l => l.code === settings.tgtLang);
  let base =
    `You are a professional simultaneous interpreter. ` +
    `The user speaks ${src.english}. ` +
    `Translate every utterance into natural, idiomatic ${tgt.english}. ` +
    `Output ONLY the ${tgt.english} translation — no explanations, no source text, ` +
    `no quotation marks, no language labels. ` +
    `Preserve speaker tone (casual stays casual, formal stays formal). ` +
    `If the user is mid-sentence, translate what is available; do not wait for the whole paragraph. ` +
    `Keep proper nouns and well-known technical terms in their conventional form.`;
  if (settings.instructions) {
    base += `\n\nAdditional style guidance from the user:\n${settings.instructions}`;
  }
  return base;
}

function buildSessionConfig() {
  const src = LANGS.find(l => l.code === settings.srcLang);
  return {
    modalities: ['text'],
    instructions: buildInstructions(),
    input_audio_transcription: {
      model: 'whisper-1',
      language: src.whisper,
    },
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
  if (!state.dc || state.dc.readyState !== 'open') return;
  state.dc.send(JSON.stringify({
    type: 'session.update',
    session: buildSessionConfig(),
  }));
}

// ---------- WebRTC lifecycle ----------

async function start() {
  setStatus('请求麦克风…');
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const pc = new RTCPeerConnection();
  state.pc = pc;

  // We don't render model audio (text mode), but accept any track silently.
  pc.ontrack = () => {};

  pc.addTrack(state.stream.getAudioTracks()[0], state.stream);

  const dc = pc.createDataChannel('oai-events');
  state.dc = dc;
  dc.addEventListener('open', () => {
    state.sessionReady = true;
    sendSessionUpdate();
    setStatus('已连接 · 正在聆听', 'live');
    $('micBtn').textContent = '停止';
    $('micBtn').classList.add('recording');
    $('micBtn').classList.remove('primary');
  });
  dc.addEventListener('message', (e) => {
    try { handleEvent(JSON.parse(e.data)); }
    catch (err) { console.warn('bad event', err, e.data); }
  });
  dc.addEventListener('close', () => { state.sessionReady = false; });

  pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      if (state.pc === pc) stop();
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  setStatus('连接 OpenAI…');
  const url = `https://api.openai.com/v1/realtime?model=${encodeURIComponent(settings.model)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
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

function stop() {
  state.sessionReady = false;
  try { state.dc && state.dc.close(); } catch {}
  try { state.pc && state.pc.close(); } catch {}
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  state.pc = state.dc = state.stream = null;
  $('micBtn').textContent = '开始';
  $('micBtn').classList.remove('recording');
  $('micBtn').classList.add('primary');
  setStatus('已停止');
}

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

// ---------- Transcript rendering ----------

function ensureSrcLine(itemId) {
  let row = state.srcItems.get(itemId);
  if (!row) {
    const el = document.createElement('div');
    el.className = 'line interim';
    $('src').appendChild(el);
    row = { el, text: '', done: false };
    state.srcItems.set(itemId, row);
  }
  return row;
}

function updateSrc(itemId, deltaOrFull, done) {
  const row = ensureSrcLine(itemId);
  if (done) {
    row.text = deltaOrFull;
    row.done = true;
    row.el.classList.remove('interim');
  } else {
    row.text += deltaOrFull;
  }
  row.el.textContent = row.text || '…';
  scrollToBottom($('src'));
}

function ensureTgtLine(responseId) {
  let row = state.tgtItems.get(responseId);
  if (!row) {
    const el = document.createElement('div');
    el.className = 'line interim';
    $('tgt').appendChild(el);
    row = { el, text: '', done: false };
    state.tgtItems.set(responseId, row);
  }
  return row;
}

function updateTgt(responseId, delta) {
  const row = ensureTgtLine(responseId);
  row.text += delta;
  row.el.textContent = row.text;
  scrollToBottom($('tgt'));
}

function finishTgt(responseId, fullText) {
  const row = ensureTgtLine(responseId);
  if (fullText) { row.text = fullText; row.el.textContent = fullText; }
  row.done = true;
  row.el.classList.remove('interim');
  scrollToBottom($('tgt'));
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

// ---------- Realtime event handling ----------

function handleEvent(ev) {
  switch (ev.type) {
    // A new conversation item was created — track user items so we can render
    // their transcript as it streams in.
    case 'conversation.item.created':
      if (ev.item && ev.item.role === 'user') {
        state.lastUserItemId = ev.item.id;
        ensureSrcLine(ev.item.id);
      }
      break;

    case 'conversation.item.input_audio_transcription.delta':
      updateSrc(ev.item_id, ev.delta || '', false);
      break;

    case 'conversation.item.input_audio_transcription.completed':
      updateSrc(ev.item_id, ev.transcript || '', true);
      break;

    case 'conversation.item.input_audio_transcription.failed':
      console.warn('transcription failed', ev);
      break;

    case 'response.created':
      if (ev.response && ev.response.id && state.lastUserItemId) {
        state.pairing.set(ev.response.id, state.lastUserItemId);
      }
      break;

    case 'response.text.delta':
      updateTgt(ev.response_id, ev.delta || '');
      break;

    case 'response.text.done':
      finishTgt(ev.response_id, ev.text || '');
      break;

    case 'response.done':
      // Some models emit only output_item events without response.text.done;
      // fall back to extracting text from response.output.
      if (ev.response && ev.response.output) {
        const text = ev.response.output
          .flatMap(o => (o.content || []))
          .map(c => c.text || c.transcript || '')
          .join('');
        if (text) finishTgt(ev.response.id, text);
      }
      break;

    case 'error':
      console.error('Realtime error:', ev);
      setStatus('错误: ' + (ev.error?.message || 'unknown'), 'err');
      break;

    default:
      // Useful while debugging:
      // console.debug('ev', ev.type, ev);
      break;
  }
}
