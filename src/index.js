// Worker entry: HTTP routes (auth, account, redeem, rooms) and WS upgrades
// (signaling + OpenAI Realtime proxy) forwarded into the Room Durable Object.

import {
  authenticateRequest,
  consumeMagicLink,
  googleAuthCallback,
  googleAuthRedirect,
  logout,
  loginUser,
  readCookie,
  requestMagicLink,
  wechatAuthCallback,
  wechatAuthRedirect,
  withClearedSessionCookie,
  withSessionCookie,
} from './auth.js';
import { redeemCode } from './codes.js';
import { recentUsage } from './db.js';

export { Room } from './room.js';

// ---------- Site gate (single shared password) ----------

const SITE_COOKIE = 'rti_site';
const SITE_COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days

async function sha256Hex(s) {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function isSiteAuthed(request, env) {
  if (!env.SITE_PASSWORD) return true;
  const cookie = readCookie(request, SITE_COOKIE);
  if (!cookie) return false;
  const expected = await sha256Hex(env.SITE_PASSWORD);
  return cookie === expected;
}

function siteCookieHeader(value, maxAge) {
  const parts = [`${SITE_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure'];
  parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

const GATE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>实时同传 · 访问</title>
<style>
:root{--bg:#0d1117;--bg-elev:#161b22;--fg:#e6edf3;--fg-dim:#7d8590;--accent:#58a6ff;--border:#30363d;--err:#f85149}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",sans-serif}
.card{background:var(--bg-elev);border:1px solid var(--border);border-radius:14px;padding:2rem;width:min(380px,92vw)}
h1{margin:0 0 .25rem;font-size:1.4rem}
.lede{color:var(--fg-dim);font-size:.88rem;margin:0 0 1.2rem}
label{display:block;font-size:.8rem;color:var(--fg-dim);margin-bottom:.4rem}
input{width:100%;padding:.65rem .8rem;background:#0d1117;border:1px solid var(--border);border-radius:8px;color:var(--fg);font-size:1rem;font-family:inherit}
input:focus{outline:none;border-color:var(--accent)}
button{margin-top:1rem;width:100%;padding:.7rem;background:var(--accent);border:none;border-radius:8px;color:#fff;font-size:.95rem;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
.err{margin:.7rem 0 0;color:var(--err);font-size:.85rem;display:none}
.err.on{display:block}
</style></head><body>
<form class="card" id="f">
<h1>实时同传</h1>
<p class="lede">受邀访问。请输入访问密码。</p>
<label for="p">访问密码</label>
<input id="p" type="password" required autofocus autocomplete="off">
<button type="submit" id="b">进入</button>
<p class="err" id="e">密码错误</p>
</form>
<script>
const f=document.getElementById('f'),p=document.getElementById('p'),b=document.getElementById('b'),e=document.getElementById('e');
f.onsubmit=async ev=>{ev.preventDefault();e.classList.remove('on');b.disabled=true;
try{const r=await fetch('/api/site-auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p.value})});
if(r.ok){const u=new URLSearchParams(location.search).get('next')||'/';location.href=u;}else{e.classList.add('on');p.select();}}finally{b.disabled=false;}};
</script></body></html>`;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // ---------- Site gate (always available) ----------

    if (url.pathname === '/site-auth' && method === 'GET') {
      return new Response(GATE_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/api/site-auth' && method === 'POST') {
      if (!env.SITE_PASSWORD) return json({ error: 'no_gate' }, 503);
      const body = await readJSON(request) || {};
      if (String(body.password || '') !== String(env.SITE_PASSWORD)) {
        return json({ error: 'bad_password' }, 401);
      }
      const hash = await sha256Hex(env.SITE_PASSWORD);
      const resp = json({ ok: true });
      resp.headers.append('Set-Cookie', siteCookieHeader(hash, SITE_COOKIE_TTL));
      return resp;
    }

    if (url.pathname === '/api/site-auth/logout' && method === 'POST') {
      const resp = json({ ok: true });
      resp.headers.append('Set-Cookie', siteCookieHeader('', 0));
      return resp;
    }

    if (env.SITE_PASSWORD) {
      const ok = await isSiteAuthed(request, env);
      if (!ok) {
        if (request.headers.get('Upgrade') === 'websocket' || url.pathname.startsWith('/api/')) {
          return new Response('gate_required', { status: 401 });
        }
        const accept = request.headers.get('accept') || '';
        if (accept.includes('text/html')) {
          const next = encodeURIComponent(url.pathname + url.search);
          return Response.redirect(url.origin + '/site-auth?next=' + next, 302);
        }
        return new Response('gate_required', { status: 401 });
      }
    }

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
        gateEnabled: !!env.SITE_PASSWORD,
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
      const password = body.password ? String(body.password) : '';
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

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
};
