// Cloudflare Worker — 1-to-1 realtime interpreter (trial).
//
// All client traffic flows through this Worker; the browser never talks to
// api.openai.com directly. Two WebSockets per peer:
//
//   /api/rooms/:id/ws    room signaling: auth, peer presence, subtitle relay.
//   /api/rooms/:id/oai   OpenAI Realtime reverse proxy: the Worker opens an
//                        outgoing WebSocket to OpenAI, attaches the operator's
//                        API key (env.OPENAI_API_KEY) at handshake, and pipes
//                        frames in both directions. Also enforces a per-peer
//                        audio-input quota (env.TRIAL_SECONDS).
//
// The OpenAI API key is held only on the server side. End users do not see it,
// do not provide it, and have no need to reach OpenAI from their network.

import { DurableObject } from 'cloudflare:workers';

const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const ROOM_ID_LEN = 6;
const ROOM_TTL_MS = 1000 * 60 * 60 * 12; // 12 h
const MAX_PEERS = 2;
const OPENAI_REALTIME_HOST = 'api.openai.com';
const SAMPLE_RATE = 24000;        // OpenAI Realtime expected sample rate
const BYTES_PER_SAMPLE = 2;        // 16-bit PCM

function genRoomId() {
  let s = '';
  for (let i = 0; i < ROOM_ID_LEN; i++) {
    s += ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)];
  }
  return s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Approximate decoded byte length for a base64 string. Good enough for quota.
function base64ByteLen(s) {
  if (typeof s !== 'string' || s.length === 0) return 0;
  let pad = 0;
  if (s.endsWith('==')) pad = 2;
  else if (s.endsWith('=')) pad = 1;
  return Math.max(0, (s.length >> 2) * 3 - pad);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    // wsId -> { ws, role, language }
    this.peers = new Map();
    // ticket -> wsId; one-time use for opening the OAI proxy WS.
    this.tickets = new Map();
    // Per-role audio bytes already consumed, persists across reconnects.
    // { host: number, guest: number }
    this.audioBytes = { host: 0, guest: 0 };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      const data = await request.json();
      await this.ctx.storage.put('config', {
        roomId: data.roomId,
        password: data.password || '',
        model: data.model || (this.env.MODEL || 'gpt-4o-realtime-preview'),
        createdAt: Date.now(),
      });
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const config = await this.ctx.storage.get('config');
      if (!config) return new Response('room not found', { status: 404 });

      if (url.pathname === '/ws') {
        return this.openSignaling(config);
      }
      if (url.pathname === '/oai') {
        const ticket = url.searchParams.get('ticket') || '';
        const wsId = this.tickets.get(ticket);
        if (!wsId) return new Response('invalid ticket', { status: 401 });
        this.tickets.delete(ticket);
        const peer = this.peers.get(wsId);
        if (!peer) return new Response('peer gone', { status: 410 });
        return this.openOpenAIProxy(config, peer);
      }
    }

    return new Response('not found', { status: 404 });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  // ---------- Signaling WS ----------

  openSignaling(config) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const wsId = crypto.randomUUID();
    let authed = false;
    let info = null;

    const send = (obj) => {
      try { server.send(JSON.stringify(obj)); } catch {}
    };

    const trialSeconds = Number(this.env.TRIAL_SECONDS || 30);
    const trialBytes = trialSeconds * SAMPLE_RATE * BYTES_PER_SAMPLE;

    server.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (!authed) {
        if (msg.type !== 'auth') {
          send({ type: 'error', error: 'auth_required' });
          try { server.close(1008, 'auth required'); } catch {}
          return;
        }
        if ((config.password || '') !== (msg.password || '')) {
          send({ type: 'error', error: 'bad_password' });
          try { server.close(1008, 'bad password'); } catch {}
          return;
        }
        if (this.peers.size >= MAX_PEERS) {
          send({ type: 'error', error: 'room_full' });
          try { server.close(1008, 'room full'); } catch {}
          return;
        }
        authed = true;
        info = {
          ws: server,
          role: this.peers.size === 0 ? 'host' : 'guest',
          language: typeof msg.language === 'string' ? msg.language : 'en',
        };
        this.peers.set(wsId, info);

        const ticket = this.issueTicket(wsId);
        const peer = this.otherPeer(wsId);
        send({
          type: 'joined',
          role: info.role,
          language: info.language,
          peerPresent: !!peer,
          peerLanguage: peer ? peer.language : null,
          model: config.model,
          ticket,
          trialSeconds,
          usedBytes: this.audioBytes[info.role] || 0,
          sampleRate: SAMPLE_RATE,
        });
        if (peer) {
          try { peer.ws.send(JSON.stringify({ type: 'peer_joined', language: info.language })); } catch {}
        }
        return;
      }

      switch (msg.type) {
        case 'set_language': {
          info.language = String(msg.language || info.language);
          const peer = this.otherPeer(wsId);
          if (peer) {
            try { peer.ws.send(JSON.stringify({ type: 'peer_language', language: info.language })); } catch {}
          }
          break;
        }
        case 'subtitle': {
          const peer = this.otherPeer(wsId);
          if (!peer) break;
          try {
            peer.ws.send(JSON.stringify({
              type: 'peer_subtitle',
              id: msg.id,
              text: typeof msg.text === 'string' ? msg.text : '',
              final: !!msg.final,
            }));
          } catch {}
          break;
        }
        case 'request_ticket': {
          if ((this.audioBytes[info.role] || 0) >= trialBytes) {
            send({ type: 'quota_exceeded', usedBytes: this.audioBytes[info.role], trialSeconds });
            break;
          }
          const t = this.issueTicket(wsId);
          send({ type: 'ticket', ticket: t });
          break;
        }
        case 'ping':
          send({ type: 'pong', t: Date.now() });
          break;
      }
    });

    const cleanup = () => {
      if (!this.peers.has(wsId)) return;
      this.peers.delete(wsId);
      for (const [t, owner] of this.tickets) {
        if (owner === wsId) this.tickets.delete(t);
      }
      const peer = this.otherPeer(wsId);
      if (peer) {
        try { peer.ws.send(JSON.stringify({ type: 'peer_left' })); } catch {}
      }
    };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }

  issueTicket(wsId) {
    const t = crypto.randomUUID();
    this.tickets.set(t, wsId);
    return t;
  }

  otherPeer(selfId) {
    for (const [id, p] of this.peers) if (id !== selfId) return p;
    return null;
  }

  // ---------- OpenAI Realtime reverse proxy ----------

  async openOpenAIProxy(config, peer) {
    const apiKey = (this.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      return new Response('OPENAI_API_KEY not configured', { status: 500 });
    }

    const trialSeconds = Number(this.env.TRIAL_SECONDS || 30);
    const trialBytes = trialSeconds * SAMPLE_RATE * BYTES_PER_SAMPLE;
    const role = peer.role;

    if ((this.audioBytes[role] || 0) >= trialBytes) {
      return new Response('quota exhausted', { status: 402 });
    }

    const model = encodeURIComponent(config.model || this.env.MODEL || 'gpt-4o-realtime-preview');
    const openaiUrl = `https://${OPENAI_REALTIME_HOST}/v1/realtime?model=${model}`;

    let upRes;
    try {
      upRes = await fetch(openaiUrl, {
        headers: {
          'Upgrade': 'websocket',
          'Authorization': `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });
    } catch (e) {
      return new Response('upstream fetch failed: ' + (e?.message || e), { status: 502 });
    }
    const upstream = upRes.webSocket;
    if (!upstream) {
      let body = '';
      try { body = await upRes.text(); } catch {}
      return new Response(
        `upstream did not upgrade (${upRes.status}): ${body.slice(0, 200)}`,
        { status: 502 }
      );
    }
    upstream.accept();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      try { upstream.close(); } catch {}
      try { server.close(); } catch {}
    };

    // Client -> Worker -> OpenAI. Inspect for audio bytes; enforce quota.
    server.addEventListener('message', (e) => {
      let forwarded = false;
      if (typeof e.data === 'string') {
        // Heuristic: only parse messages that plausibly contain audio.
        if (e.data.indexOf('"input_audio_buffer.append"') !== -1) {
          let msg;
          try { msg = JSON.parse(e.data); } catch {}
          if (msg && msg.type === 'input_audio_buffer.append' && typeof msg.audio === 'string') {
            const used = this.audioBytes[role] || 0;
            const remaining = Math.max(0, trialBytes - used);
            if (remaining <= 0) {
              try {
                server.send(JSON.stringify({
                  type: 'quota_exceeded',
                  usedBytes: used,
                  trialSeconds,
                }));
              } catch {}
              closeBoth();
              return;
            }
            const incoming = base64ByteLen(msg.audio);
            const allow = Math.min(incoming, remaining);
            // For simplicity, count the full chunk; the small over-shoot at
            // the boundary is fine for a trial quota.
            this.audioBytes[role] = used + incoming;
            try { upstream.send(e.data); } catch {}
            forwarded = true;
            // Periodically tell the client how much they've used.
            const peerInfo = peer;
            const newUsed = this.audioBytes[role];
            if (peerInfo && peerInfo.ws) {
              try {
                peerInfo.ws.send(JSON.stringify({
                  type: 'quota_update',
                  usedBytes: newUsed,
                  remainingSeconds: Math.max(0, (trialBytes - newUsed) / (SAMPLE_RATE * BYTES_PER_SAMPLE)),
                  trialSeconds,
                }));
              } catch {}
            }
            if (newUsed >= trialBytes) {
              try {
                server.send(JSON.stringify({
                  type: 'quota_exceeded',
                  usedBytes: newUsed,
                  trialSeconds,
                }));
              } catch {}
              // Let the client finish what's in flight; close after a tick.
              closeBoth();
              return;
            }
          }
        }
      }
      if (!forwarded) {
        try { upstream.send(e.data); } catch {}
      }
    });

    // OpenAI -> Worker -> Client (passthrough).
    upstream.addEventListener('message', (e) => {
      try { server.send(e.data); } catch {}
    });

    server.addEventListener('close', closeBoth);
    server.addEventListener('error', closeBoth);
    upstream.addEventListener('close', closeBoth);
    upstream.addEventListener('error', closeBoth);

    return new Response(null, { status: 101, webSocket: client });
  }
}

// ---------- Worker entrypoint ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { body = {}; }
      const password = (body && body.password) ? String(body.password) : '';

      for (let attempt = 0; attempt < 5; attempt++) {
        const roomId = genRoomId();
        const id = env.ROOM.idFromName(roomId);
        const stub = env.ROOM.get(id);
        const initResp = await stub.fetch('https://room/init', {
          method: 'POST',
          body: JSON.stringify({
            roomId,
            password,
            model: env.MODEL || 'gpt-4o-realtime-preview',
          }),
        });
        if (initResp.ok) return json({ roomId });
      }
      return json({ error: 'create_failed' }, 500);
    }

    const m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4,12})\/(ws|oai)$/i);
    if (m) {
      const roomId = m[1].toUpperCase();
      const action = m[2].toLowerCase();
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      const innerUrl = new URL(request.url);
      innerUrl.pathname = '/' + action;
      const innerReq = new Request(innerUrl.toString(), request);
      return stub.fetch(innerReq);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
};
