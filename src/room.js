// Durable Object: per-room signaling + OpenAI Realtime reverse proxy.
//
// Two WebSockets per peer:
//   /ws   signaling (auth, peer state, subtitle relay, quota updates)
//   /oai  raw proxy to OpenAI Realtime over WebSocket; key attached server-side
//
// Quota: anonymous users get a per-role trial (env.TRIAL_SECONDS, default 30).
// Logged-in users (identity passed via X-User-Id header from the Worker entry)
// consume from their D1 balance. Balance is fetched on connect and again on
// every flush; deductions are written to D1 every FLUSH_INTERVAL_MS while
// audio is flowing, and once more on disconnect.

import { DurableObject } from 'cloudflare:workers';
import { deductBalance, getUserById } from './db.js';

const MAX_PEERS = 2;
const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;
const FLUSH_INTERVAL_MS = 5000;
const OPENAI_REALTIME_HOST = 'api.openai.com';
const ROOM_TTL_MS = 1000 * 60 * 60 * 12;

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
    this.peers = new Map();         // wsId -> peer
    this.tickets = new Map();       // ticket -> wsId
    this.trialBytes = { host: 0, guest: 0 };
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
      if (url.pathname === '/ws') return this.openSignaling(request, config);
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

  openSignaling(request, config) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const wsId = crypto.randomUUID();
    const userId = request.headers.get('X-User-Id') || null;
    const displayName = request.headers.get('X-User-Name') || null;
    const userEmail = request.headers.get('X-User-Email') || null;
    const trialSeconds = Number(this.env.TRIAL_SECONDS || 30);

    let authed = false;
    let peer = null;

    const send = (obj) => { try { server.send(JSON.stringify(obj)); } catch {} };

    server.addEventListener('message', async (evt) => {
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
        const role = this.peers.size === 0 ? 'host' : 'guest';
        let initialBalance = 0;
        if (userId) {
          const u = await getUserById(this.env, userId);
          initialBalance = Number(u?.balance_seconds || 0);
        }
        peer = {
          ws: server,
          wsId,
          role,
          language: typeof msg.language === 'string' ? msg.language : 'en',
          userId,
          displayName,
          userEmail,
          // Anonymous: counts against trial. Logged-in: counts against balance.
          trialBytes: this.trialBytes[role] || 0,
          balanceSeconds: initialBalance,
          // Bytes audio-proxied within this peer's lifetime (in DO memory).
          bytesSpent: 0,
          // Bytes already persisted to D1.
          bytesFlushed: 0,
          lastFlushAt: Date.now(),
          flushTimer: null,
        };
        this.peers.set(wsId, peer);

        const ticket = this.issueTicket(wsId);
        const other = this.otherPeer(wsId);
        send({
          type: 'joined',
          role: peer.role,
          language: peer.language,
          peerPresent: !!other,
          peerLanguage: other ? other.language : null,
          model: config.model,
          ticket,
          anonymous: !userId,
          trialSeconds,
          trialUsedSeconds: peer.trialBytes / BYTES_PER_SECOND,
          balanceSeconds: initialBalance,
          email: userEmail || null,
          displayName: displayName || null,
        });
        if (other) {
          try { other.ws.send(JSON.stringify({ type: 'peer_joined', language: peer.language })); } catch {}
        }
        return;
      }

      switch (msg.type) {
        case 'set_language': {
          peer.language = String(msg.language || peer.language);
          const other = this.otherPeer(wsId);
          if (other) {
            try { other.ws.send(JSON.stringify({ type: 'peer_language', language: peer.language })); } catch {}
          }
          break;
        }
        case 'subtitle': {
          const other = this.otherPeer(wsId);
          if (!other) break;
          try {
            other.ws.send(JSON.stringify({
              type: 'peer_subtitle',
              id: msg.id,
              text: typeof msg.text === 'string' ? msg.text : '',
              final: !!msg.final,
            }));
          } catch {}
          break;
        }
        case 'request_ticket': {
          if (this.peerQuotaExhausted(peer, trialSeconds)) {
            send({ type: 'quota_exceeded', reason: peer.userId ? 'balance' : 'trial' });
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

    const cleanup = async () => {
      if (!this.peers.has(wsId)) return;
      this.peers.delete(wsId);
      for (const [t, owner] of this.tickets) {
        if (owner === wsId) this.tickets.delete(t);
      }
      const other = this.otherPeer(wsId);
      if (other) {
        try { other.ws.send(JSON.stringify({ type: 'peer_left' })); } catch {}
      }
      if (peer) {
        // Final flush to D1.
        await this.flushUsage(peer, true).catch((e) => console.error('flush on close', e));
      }
    };
    server.addEventListener('close', () => { cleanup(); });
    server.addEventListener('error', () => { cleanup(); });

    return new Response(null, { status: 101, webSocket: client });
  }

  peerQuotaExhausted(peer, trialSeconds) {
    if (peer.userId) {
      const remaining = peer.balanceSeconds - peer.bytesSpent / BYTES_PER_SECOND;
      return remaining <= 0;
    }
    const trialBytes = trialSeconds * BYTES_PER_SECOND;
    return (peer.trialBytes + peer.bytesSpent) >= trialBytes;
  }

  remainingSeconds(peer, trialSeconds) {
    if (peer.userId) {
      return Math.max(0, peer.balanceSeconds - peer.bytesSpent / BYTES_PER_SECOND);
    }
    const trialBytes = trialSeconds * BYTES_PER_SECOND;
    const usedBytes = peer.trialBytes + peer.bytesSpent;
    return Math.max(0, (trialBytes - usedBytes) / BYTES_PER_SECOND);
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

  async flushUsage(peer, finalize = false) {
    if (!peer.userId) {
      // Anonymous: persist trial counter in DO memory across reconnects.
      this.trialBytes[peer.role] = (this.trialBytes[peer.role] || 0) + (peer.bytesSpent - (peer.bytesFlushed || 0));
      peer.bytesFlushed = peer.bytesSpent;
      return;
    }
    const newBytes = peer.bytesSpent - peer.bytesFlushed;
    if (newBytes <= 0) return;
    const seconds = newBytes / BYTES_PER_SECOND;
    const actual = await deductBalance(this.env, peer.userId, seconds, peer.roomId || null, 'room');
    peer.bytesFlushed = peer.bytesSpent;
    // Refresh balance snapshot occasionally (keeps remaining-time correct if
    // user redeemed mid-call from another tab).
    if (finalize || (Date.now() - peer.lastFlushAt > 30000)) {
      const u = await getUserById(this.env, peer.userId);
      if (u) {
        peer.balanceSeconds = Number(u.balance_seconds || 0) + (peer.bytesSpent - peer.bytesFlushed) / BYTES_PER_SECOND;
      }
      peer.lastFlushAt = Date.now();
    }
    return actual;
  }

  // ---------- OpenAI Realtime reverse proxy ----------

  async openOpenAIProxy(config, peer) {
    const apiKey = (this.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) return new Response('OPENAI_API_KEY not configured', { status: 500 });

    const trialSeconds = Number(this.env.TRIAL_SECONDS || 30);
    if (this.peerQuotaExhausted(peer, trialSeconds)) {
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
      let body = ''; try { body = await upRes.text(); } catch {}
      return new Response(`upstream did not upgrade (${upRes.status}): ${body.slice(0, 200)}`, { status: 502 });
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
      this.flushUsage(peer, true).catch((e) => console.error('flush', e));
    };

    // Periodic flush while audio is flowing.
    const flushInterval = setInterval(() => {
      this.flushUsage(peer, false).catch((e) => console.error('periodic flush', e));
      // Periodic quota update push.
      try {
        peer.ws.send(JSON.stringify({
          type: 'quota_update',
          remainingSeconds: this.remainingSeconds(peer, trialSeconds),
          balanceSeconds: peer.userId ? Math.max(0, peer.balanceSeconds - peer.bytesSpent / BYTES_PER_SECOND) : null,
          trialUsedSeconds: !peer.userId ? (peer.trialBytes + peer.bytesSpent) / BYTES_PER_SECOND : null,
        }));
      } catch {}
    }, FLUSH_INTERVAL_MS);
    const origClose = closeBoth;
    const closeAll = () => { clearInterval(flushInterval); origClose(); };

    // Client -> Worker -> OpenAI; count audio bytes for quota.
    server.addEventListener('message', (e) => {
      if (typeof e.data === 'string' && e.data.indexOf('"input_audio_buffer.append"') !== -1) {
        let msg;
        try { msg = JSON.parse(e.data); } catch {}
        if (msg && msg.type === 'input_audio_buffer.append' && typeof msg.audio === 'string') {
          const incoming = base64ByteLen(msg.audio);
          peer.bytesSpent += incoming;
          const remaining = this.remainingSeconds(peer, trialSeconds);
          if (remaining <= 0) {
            try {
              peer.ws.send(JSON.stringify({
                type: 'quota_exceeded',
                reason: peer.userId ? 'balance' : 'trial',
              }));
            } catch {}
            try { server.send(e.data); } catch {}
            closeAll();
            return;
          }
        }
      }
      try { upstream.send(e.data); } catch {}
    });

    upstream.addEventListener('message', (e) => {
      try { server.send(e.data); } catch {}
    });

    server.addEventListener('close', closeAll);
    server.addEventListener('error', closeAll);
    upstream.addEventListener('close', closeAll);
    upstream.addEventListener('error', closeAll);

    return new Response(null, { status: 101, webSocket: client });
  }
}
