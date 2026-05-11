// Worker entry: HTTP routes (auth, account, redeem, rooms) and WS upgrades
// (signaling + OpenAI Realtime proxy) forwarded into the Room Durable Object.
//
// Access model:
//   - Anyone can land on the SPA and join a room with just a room code.
//   - Creating a room requires SITE_PASSWORD (the operator-only key that
//     gates OpenAI token spend). Verified per-request from the create form.

import {
  authenticateRequest,
  consumeMagicLink,
  googleAuthCallback,
  googleAuthRedirect,
  logout,
  loginUser,
  requestMagicLink,
  wechatAuthCallback,
  wechatAuthRedirect,
  withClearedSessionCookie,
  withSessionCookie,
} from './auth.js';
import { redeemCode } from './codes.js';
import { recentUsage } from './db.js';

export { Room } from './room.js';

const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID_LEN = 6;

function genRoomId() {
  let s = '';
  for (let i = 0; i < ROOM_ID_LEN; i++) {
    s += ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)];
  }
  return s;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

async function readJSON(request) {
  try { return await request.json(); } catch { return null; }
}

// ---------- Solo-mode helpers ----------
// Solo mode skips the Room DO: a single browser proxies straight through
// the Worker to OpenAI Realtime. We don't want the OPENAI key reachable
// from anywhere on the open web, so /api/solo/oai requires a short-lived
// HMAC ticket that you can only mint by knowing SITE_PASSWORD.

const SOLO_TICKET_TTL_SECONDS = 300;

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = '==='.slice((str.length + 3) % 4);
  const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function makeSoloTicket(env) {
  const exp = Math.floor(Date.now() / 1000) + SOLO_TICKET_TTL_SECONDS;
  const payload = 'solo|' + exp;
  const key = await hmacKey(env.SITE_PASSWORD);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return exp + '.' + b64urlEncode(new Uint8Array(sig));
}

async function verifySoloTicket(env, ticket) {
  try {
    const [expStr, sigB64] = String(ticket || '').split('.');
    const exp = Number(expStr);
    if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
    const payload = 'solo|' + exp;
    const key = await hmacKey(env.SITE_PASSWORD);
    return await crypto.subtle.verify(
      'HMAC', key, b64urlDecode(sigB64), new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

async function proxySoloOpenAI(env) {
  const apiKey = (env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return new Response('OPENAI_API_KEY not configured', { status: 500 });

  const model = encodeURIComponent(env.MODEL || 'gpt-4o-realtime-preview');
  const openaiUrl = 'https://api.openai.com/v1/realtime?model=' + model;

  let upRes;
  try {
    upRes = await fetch(openaiUrl, {
      headers: {
        'Upgrade': 'websocket',
        'Authorization': 'Bearer ' + apiKey,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
  } catch (e) {
    return new Response('upstream fetch failed: ' + (e?.message || e), { status: 502 });
  }
  const upstream = upRes.webSocket;
  if (!upstream) {
    let body = ''; try { body = await upRes.text(); } catch {}
    return new Response('upstream did not upgrade (' + upRes.status + '): ' + body.slice(0, 200), { status: 502 });
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

  server.addEventListener('message', (e) => { if (!closed) try { upstream.send(e.data); } catch {} });
  upstream.addEventListener('message', (e) => { if (!closed) try { server.send(e.data); } catch {} });
  server.addEventListener('close', closeBoth);
  upstream.addEventListener('close', closeBoth);
  server.addEventListener('error', closeBoth);
  upstream.addEventListener('error', closeBoth);

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // ---------- Auth (HTTP) — dormant in invite-only mode (no DB binding) ----------

    if (!env.DB && (
      url.pathname.startsWith('/api/auth/') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname === '/api/me' ||
      url.pathname === '/api/me/usage' ||
      url.pathname === '/api/redeem'
    )) {
      return json({ error: 'accounts_disabled' }, 503);
    }

    if (url.pathname === '/api/auth/magic' && method === 'POST') {
      const body = await readJSON(request) || {};
      const res = await requestMagicLink(env, request, body.email);
      if (!res.ok) return json({ error: res.error }, res.status || 400);
      return json({ ok: true });
    }

    if (url.pathname === '/auth/magic' && method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) return new Response('missing token', { status: 400 });
      const r = await consumeMagicLink(env, token);
      if (!r.ok) {
        return new Response(`登录失败：${r.error}`, {
          status: 400,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      const sess = await loginUser(env, r.user.id);
      const resp = Response.redirect(url.origin + '/#/account', 302);
      return withSessionCookie(resp, sess.token);
    }

    if (url.pathname === '/auth/google' && method === 'GET') {
      return await googleAuthRedirect(env, request);
    }
    if (url.pathname === '/auth/google/callback' && method === 'GET') {
      return await googleAuthCallback(env, request);
    }
    if (url.pathname === '/auth/wechat' && method === 'GET') {
      return await wechatAuthRedirect(env, request);
    }
    if (url.pathname === '/auth/wechat/callback' && method === 'GET') {
      return await wechatAuthCallback(env, request);
    }

    if (url.pathname === '/api/auth/logout' && method === 'POST') {
      await logout(env, request);
      return withClearedSessionCookie(json({ ok: true }));
    }

    // ---------- Account ----------

    if (url.pathname === '/api/me' && method === 'GET') {
      const sess = await authenticateRequest(env, request);
      if (!sess) return json({ authenticated: false });
      return json({
        authenticated: true,
        userId: sess.user_id,
        email: sess.email,
        displayName: sess.display_name,
        balanceSeconds: Number(sess.balance_seconds || 0),
        hasGoogle: !!sess.google_sub,
        hasWechat: !!sess.wechat_unionid,
      });
    }

    if (url.pathname === '/api/me/usage' && method === 'GET') {
      const sess = await authenticateRequest(env, request);
      if (!sess) return json({ error: 'unauthenticated' }, 401);
      const rows = await recentUsage(env, sess.user_id, 50);
      return json({ usage: rows });
    }

    if (url.pathname === '/api/redeem' && method === 'POST') {
      const sess = await authenticateRequest(env, request);
      if (!sess) return json({ error: 'unauthenticated' }, 401);
      const body = await readJSON(request) || {};
      const result = await redeemCode(env, sess.user_id, body.code);
      if (!result.ok) return json({ error: result.error }, 400);
      return json({ ok: true, seconds: result.seconds, label: result.label });
    }

    // ---------- Available login methods (so UI can hide buttons) ----------

    if (url.pathname === '/api/config' && method === 'GET') {
      return json({
        trialSeconds: Number(env.TRIAL_SECONDS || 60),
        createRequiresPassword: !!env.SITE_PASSWORD,
        loginMethods: {
          email: true,
          google: !!env.GOOGLE_CLIENT_ID,
          wechat: !!env.WECHAT_APP_ID,
        },
      });
    }

    // ---------- Rooms ----------

    if (url.pathname === '/api/rooms' && method === 'POST') {
      const body = await readJSON(request) || {};
      // Creating a room costs OpenAI tokens, so it requires SITE_PASSWORD
      // (the operator-only key). The returned roomId is a freshly-generated
      // share code — distinct from SITE_PASSWORD — that the creator hands
      // to the other party. Joining the WS endpoints below is open to
      // anyone who knows that roomId.
      if (env.SITE_PASSWORD && String(body.sitePassword || '') !== String(env.SITE_PASSWORD)) {
        return json({ error: 'bad_site_password' }, 401);
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const roomId = genRoomId();
        const id = env.ROOM.idFromName(roomId);
        const stub = env.ROOM.get(id);
        const initResp = await stub.fetch('https://room/init', {
          method: 'POST',
          body: JSON.stringify({
            roomId,
            password: '',
            model: env.MODEL || 'gpt-4o-realtime-preview',
          }),
        });
        if (initResp.ok) return json({ roomId });
      }
      return json({ error: 'create_failed' }, 500);
    }

    // ---------- Solo mode (single device, two people taking turns) ----------

    if (url.pathname === '/api/solo' && method === 'POST') {
      const body = await readJSON(request) || {};
      if (env.SITE_PASSWORD && String(body.sitePassword || '') !== String(env.SITE_PASSWORD)) {
        return json({ error: 'bad_site_password' }, 401);
      }
      const ticket = await makeSoloTicket(env);
      return json({ ticket });
    }

    if (url.pathname === '/api/solo/oai') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 400 });
      }
      const ticket = url.searchParams.get('ticket') || '';
      const ok = await verifySoloTicket(env, ticket);
      if (!ok) return new Response('invalid ticket', { status: 401 });
      return proxySoloOpenAI(env);
    }

    const m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4,12})\/(ws|oai)$/i);
    if (m) {
      const roomId = m[1].toUpperCase();
      const action = m[2].toLowerCase();
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);

      // Forward request, rewriting path. For the signaling WS, attach the
      // authenticated user's identity as headers so the DO can decide between
      // trial and balance quota modes.
      const innerUrl = new URL(request.url);
      innerUrl.pathname = '/' + action;

      const headers = new Headers(request.headers);
      if (action === 'ws' && env.DB) {
        const sess = await authenticateRequest(env, request);
        if (sess) {
          headers.set('X-User-Id', sess.user_id);
          if (sess.email) headers.set('X-User-Email', sess.email);
          if (sess.display_name) headers.set('X-User-Name', sess.display_name);
        }
      }
      const innerReq = new Request(innerUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      });
      return stub.fetch(innerReq);
    }

    if (env.ASSETS) {
      const resp = await env.ASSETS.fetch(request);
      // Don't let browsers serve stale HTML / JS across deploys.
      const headers = new Headers(resp.headers);
      headers.set('cache-control', 'no-cache, must-revalidate');
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    }
    return new Response('not found', { status: 404 });
  },
};
