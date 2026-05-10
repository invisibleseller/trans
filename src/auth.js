// Auth: cookies, magic links via Resend, Google OAuth, session lookup.
// WeChat OAuth (开放平台扫码) scaffolding lives here too but requires WECHAT_*
// secrets to be set and the production app to pass 开放平台 资质审核.

import {
  attachIdentity,
  createSession,
  createUser,
  deleteSession,
  getSession,
  getUserByEmail,
  getUserByGoogle,
  getUserByWechat,
} from './db.js';

const SESSION_COOKIE = 'rti_sess';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30d, seconds
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// ---------- Cookies ----------

export function readCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i);
    if (k === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

function setCookieHeader(name, value, { maxAge = COOKIE_MAX_AGE, secure = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function clearCookieHeader(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

export async function authenticateRequest(env, request) {
  const tok = readCookie(request, SESSION_COOKIE);
  if (!tok) return null;
  return await getSession(env, tok);
}

// ---------- Magic link ----------

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function requestMagicLink(env, request, email) {
  email = String(email || '').toLowerCase().trim();
  if (!EMAIL_RX.test(email)) {
    return { ok: false, status: 400, error: 'invalid_email' };
  }
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expires = Date.now() + MAGIC_LINK_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, ?)`
  ).bind(token, email, expires).run();

  const origin = publicOrigin(env, request);
  const link = `${origin}/auth/magic?token=${encodeURIComponent(token)}`;

  try { await sendMagicEmail(env, email, link); }
  catch (e) { console.error('email send failed', e); }

  return { ok: true };
}

function publicOrigin(env, request) {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/$/, '');
  const url = new URL(request.url);
  return url.origin;
}

async function sendMagicEmail(env, email, link) {
  if (!env.RESEND_API_KEY) {
    console.log('[dev] magic link for %s: %s', email, link);
    return;
  }
  const from = env.EMAIL_FROM || 'noreply@example.com';
  const subject = '登录链接 · 实时同传';
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#222;line-height:1.6">
  <p>你好，</p>
  <p>请点击下面的链接登录"实时同传"账户，<strong>链接 15 分钟内有效、仅可使用一次</strong>：</p>
  <p><a href="${link}" style="display:inline-block;background:#2f81f7;color:white;padding:10px 16px;border-radius:6px;text-decoration:none">登录</a></p>
  <p style="color:#888;font-size:12px">或复制此链接到浏览器：<br>${link}</p>
  <p style="color:#888;font-size:12px">如果不是你发起的，请忽略此邮件。</p>
</body></html>`;
  const text = `登录链接（15 分钟内有效）：\n${link}\n\n如果不是你发起的，请忽略。`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [email], subject, html, text }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('Resend ' + resp.status + ': ' + t.slice(0, 200));
  }
}

export async function consumeMagicLink(env, token) {
  const row = await env.DB.prepare(
    `SELECT token, email, expires_at, used_at FROM magic_links WHERE token = ?`
  ).bind(token).first();
  if (!row) return { ok: false, error: 'invalid' };
  if (row.used_at) return { ok: false, error: 'used' };
  if (Number(row.expires_at) < Date.now()) return { ok: false, error: 'expired' };
  await env.DB.prepare('UPDATE magic_links SET used_at = ? WHERE token = ?')
    .bind(Date.now(), token).run();
  let user = await getUserByEmail(env, row.email);
  if (!user) user = await createUser(env, { email: row.email });
  return { ok: true, user };
}

export async function loginUser(env, userId) {
  const sess = await createSession(env, userId);
  return sess;
}

export function withSessionCookie(response, sessionToken) {
  response.headers.append('Set-Cookie', setCookieHeader(SESSION_COOKIE, sessionToken));
  return response;
}

export function withClearedSessionCookie(response) {
  response.headers.append('Set-Cookie', clearCookieHeader(SESSION_COOKIE));
  return response;
}

export async function logout(env, request) {
  const tok = readCookie(request, SESSION_COOKIE);
  if (tok) await deleteSession(env, tok);
}

// ---------- OAuth state (anti-CSRF) ----------

async function newOAuthState(env, provider) {
  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare(
    `INSERT INTO oauth_state (state, provider, expires_at) VALUES (?, ?, ?)`
  ).bind(state, provider, Date.now() + OAUTH_STATE_TTL_MS).run();
  return state;
}

async function consumeOAuthState(env, state, provider) {
  const row = await env.DB.prepare(
    `SELECT state, provider, expires_at FROM oauth_state WHERE state = ?`
  ).bind(state).first();
  if (!row) return false;
  await env.DB.prepare('DELETE FROM oauth_state WHERE state = ?').bind(state).run();
  if (row.provider !== provider) return false;
  if (Number(row.expires_at) < Date.now()) return false;
  return true;
}

// ---------- Google OAuth ----------

export async function googleAuthRedirect(env, request) {
  if (!env.GOOGLE_CLIENT_ID) {
    return new Response('Google OAuth not configured', { status: 503 });
  }
  const state = await newOAuthState(env, 'google');
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: publicOrigin(env, request) + '/auth/google/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

export async function googleAuthCallback(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return new Response('missing code/state', { status: 400 });
  const ok = await consumeOAuthState(env, state, 'google');
  if (!ok) return new Response('bad state', { status: 400 });

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: publicOrigin(env, request) + '/auth/google/callback',
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenResp.ok) {
    const t = await tokenResp.text();
    return new Response('token exchange failed: ' + t.slice(0, 200), { status: 502 });
  }
  const tokens = await tokenResp.json();

  const infoResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoResp.ok) return new Response('userinfo failed', { status: 502 });
  const info = await infoResp.json();
  // info: { sub, email, email_verified, name, picture, ... }

  let user = await getUserByGoogle(env, info.sub);
  if (!user && info.email) user = await getUserByEmail(env, String(info.email).toLowerCase());
  if (!user) {
    user = await createUser(env, {
      email: info.email ? String(info.email).toLowerCase() : null,
      googleSub: info.sub,
      displayName: info.name || null,
    });
  } else {
    await attachIdentity(env, user.id, {
      googleSub: info.sub,
      email: info.email ? String(info.email).toLowerCase() : undefined,
      displayName: info.name || undefined,
    });
  }

  const sess = await loginUser(env, user.id);
  const resp = Response.redirect(publicOrigin(env, request) + '/#/account', 302);
  return withSessionCookie(resp, sess.token);
}

// ---------- WeChat 开放平台 扫码登录 (placeholder) ----------

export async function wechatAuthRedirect(env, request) {
  if (!env.WECHAT_APP_ID) {
    return new Response('WeChat OAuth not configured', { status: 503 });
  }
  const state = await newOAuthState(env, 'wechat');
  const redirect = publicOrigin(env, request) + '/auth/wechat/callback';
  const params = new URLSearchParams({
    appid: env.WECHAT_APP_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'snsapi_login',
    state,
  });
  return Response.redirect(
    `https://open.weixin.qq.com/connect/qrconnect?${params}#wechat_redirect`,
    302
  );
}

export async function wechatAuthCallback(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return new Response('missing code/state', { status: 400 });
  const ok = await consumeOAuthState(env, state, 'wechat');
  if (!ok) return new Response('bad state', { status: 400 });

  const tokenResp = await fetch('https://api.weixin.qq.com/sns/oauth2/access_token?'
    + new URLSearchParams({
      appid: env.WECHAT_APP_ID,
      secret: env.WECHAT_APP_SECRET,
      code,
      grant_type: 'authorization_code',
    }));
  if (!tokenResp.ok) return new Response('wechat token failed', { status: 502 });
  const tokens = await tokenResp.json();
  if (tokens.errcode) return new Response('wechat error: ' + tokens.errmsg, { status: 502 });

  const infoResp = await fetch('https://api.weixin.qq.com/sns/userinfo?'
    + new URLSearchParams({
      access_token: tokens.access_token,
      openid: tokens.openid,
      lang: 'zh_CN',
    }));
  const info = await infoResp.json();

  const unionid = info.unionid || tokens.unionid || null;
  if (!unionid) return new Response('wechat unionid missing (app must have unionid scope)', { status: 502 });

  let user = await getUserByWechat(env, unionid);
  if (!user) {
    user = await createUser(env, {
      wechatUnionid: unionid,
      displayName: info.nickname || null,
    });
  } else {
    await attachIdentity(env, user.id, {
      wechatUnionid: unionid,
      displayName: info.nickname || undefined,
    });
  }

  const sess = await loginUser(env, user.id);
  const resp = Response.redirect(publicOrigin(env, request) + '/#/account', 302);
  return withSessionCookie(resp, sess.token);
}

export { SESSION_COOKIE };
