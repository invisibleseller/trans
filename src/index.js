// Cloudflare Worker: room signaling, ephemeral OpenAI token minting, and
// WebSocket relay between exactly two peers (host + guest).
//
// The host's real OpenAI API key is stored only inside the Durable Object;
// browsers never see it. Each peer's browser requests a short-lived
// ephemeral session token, then connects directly to OpenAI Realtime via
// WebRTC. Translated subtitle text is forwarded peer-to-peer through the
// Durable Object's WebSocket.

import { DurableObject } from 'cloudflare:workers';

const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const ROOM_ID_LEN = 6;
const ROOM_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const MAX_PEERS = 2;

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

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    // peers: Map<wsId, { ws, role, language }>
    this.peers = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      const data = await request.json();
      await this.ctx.storage.put('config', {
        roomId: data.roomId,
        apiKey: data.apiKey,
        password: data.password || '',
        model: data.model || 'gpt-4o-realtime-preview',
        createdAt: Date.now(),
      });
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const config = await this.ctx.storage.get('config');
      if (!config) return new Response('room not found', { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.acceptPeer(server, config);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm() {
    // TTL cleanup.
    await this.ctx.storage.deleteAll();
  }

  acceptPeer(ws, config) {
    ws.accept();
    const wsId = crypto.randomUUID();
    let authed = false;
    let info = null;

    const send = (obj) => {
      try { ws.send(JSON.stringify(obj)); } catch {}
    };

    ws.addEventListener('message', async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (!authed) {
        if (msg.type !== 'auth') {
          send({ type: 'error', error: 'auth_required' });
          try { ws.close(1008, 'auth required'); } catch {}
          return;
        }
        if ((config.password || '') !== (msg.password || '')) {
          send({ type: 'error', error: 'bad_password' });
          try { ws.close(1008, 'bad password'); } catch {}
          return;
        }
        if (this.peers.size >= MAX_PEERS) {
          send({ type: 'error', error: 'room_full' });
          try { ws.close(1008, 'room full'); } catch {}
          return;
        }
        authed = true;
        info = {
          ws,
          role: this.peers.size === 0 ? 'host' : 'guest',
          language: typeof msg.language === 'string' ? msg.language : 'en',
        };
        this.peers.set(wsId, info);

        let ephemeral;
        try {
          ephemeral = await mintEphemeral(config);
        } catch (err) {
          send({ type: 'error', error: 'ephemeral_failed', detail: String(err.message || err) });
          try { ws.close(1011, 'ephemeral failed'); } catch {}
          this.peers.delete(wsId);
          return;
        }

        const peer = this.otherPeer(wsId);
        send({
          type: 'joined',
          role: info.role,
          language: info.language,
          peerPresent: !!peer,
          peerLanguage: peer ? peer.language : null,
          model: config.model,
          ephemeral,
        });
        if (peer) {
          try {
            peer.ws.send(JSON.stringify({
              type: 'peer_joined',
              language: info.language,
            }));
          } catch {}
        }
        return;
      }

      switch (msg.type) {
        case 'set_language': {
          info.language = String(msg.language || info.language);
          const peer = this.otherPeer(wsId);
          if (peer) {
            try {
              peer.ws.send(JSON.stringify({
                type: 'peer_language',
                language: info.language,
              }));
            } catch {}
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
        case 'refresh_ephemeral': {
          try {
            const eph = await mintEphemeral(config);
            send({ type: 'ephemeral', ephemeral: eph });
          } catch (err) {
            send({ type: 'error', error: 'ephemeral_failed', detail: String(err.message || err) });
          }
          break;
        }
        case 'ping':
          send({ type: 'pong', t: Date.now() });
          break;
      }
    });

    const onClose = () => {
      if (!this.peers.has(wsId)) return;
      this.peers.delete(wsId);
      const peer = this.otherPeer(wsId);
      if (peer) {
        try { peer.ws.send(JSON.stringify({ type: 'peer_left' })); } catch {}
      }
    };
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onClose);
  }

  otherPeer(selfId) {
    for (const [id, p] of this.peers) if (id !== selfId) return p;
    return null;
  }
}

async function mintEphemeral(config) {
  const resp = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      modalities: ['text'],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${t.slice(0, 200)}`);
  }
  return await resp.json();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Create room
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'invalid_json' }, 400); }
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!apiKey.startsWith('sk-')) return json({ error: 'apiKey_required' }, 400);

      // Try a few times in the (vanishingly unlikely) case of an ID collision.
      for (let attempt = 0; attempt < 5; attempt++) {
        const roomId = genRoomId();
        const id = env.ROOM.idFromName(roomId);
        const stub = env.ROOM.get(id);
        const initResp = await stub.fetch('https://room/init', {
          method: 'POST',
          body: JSON.stringify({
            roomId,
            apiKey,
            password: (body.password || '').toString(),
            model: (body.model || 'gpt-4o-realtime-preview').toString(),
          }),
        });
        if (initResp.ok) return json({ roomId });
      }
      return json({ error: 'create_failed' }, 500);
    }

    // WebSocket upgrade
    const m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4,12})\/ws$/i);
    if (m) {
      const roomId = m[1].toUpperCase();
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    // Static assets
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
};
