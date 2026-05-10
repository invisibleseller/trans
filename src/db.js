// D1 helpers. All queries are parameterized.

export async function getUserById(env, id) {
  if (!id) return null;
  return await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

export async function getUserByEmail(env, email) {
  if (!email) return null;
  return await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}

export async function getUserByGoogle(env, sub) {
  if (!sub) return null;
  return await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(sub).first();
}

export async function getUserByWechat(env, unionid) {
  if (!unionid) return null;
  return await env.DB.prepare('SELECT * FROM users WHERE wechat_unionid = ?').bind(unionid).first();
}

export async function createUser(env, { email, googleSub, wechatUnionid, displayName }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, google_sub, wechat_unionid, display_name, balance_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).bind(id, email || null, googleSub || null, wechatUnionid || null, displayName || null, now).run();
  return await getUserById(env, id);
}

export async function attachIdentity(env, userId, fields) {
  const sets = [];
  const args = [];
  if ('email' in fields)         { sets.push('email = COALESCE(email, ?)');               args.push(fields.email); }
  if ('googleSub' in fields)     { sets.push('google_sub = COALESCE(google_sub, ?)');     args.push(fields.googleSub); }
  if ('wechatUnionid' in fields) { sets.push('wechat_unionid = COALESCE(wechat_unionid, ?)'); args.push(fields.wechatUnionid); }
  if ('displayName' in fields)   { sets.push('display_name = COALESCE(display_name, ?)'); args.push(fields.displayName); }
  if (!sets.length) return;
  args.push(userId);
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(env, userId) {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).bind(token, userId, now + SESSION_TTL_MS, now).run();
  return { token, expiresAt: now + SESSION_TTL_MS };
}

export async function getSession(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.token, s.user_id, s.expires_at,
            u.email, u.display_name, u.balance_seconds, u.google_sub, u.wechat_unionid
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run().catch(() => {});
    return null;
  }
  return row;
}

export async function deleteSession(env, token) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

export async function addBalance(env, userId, seconds, reason = 'recharge', roomId = null) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET balance_seconds = balance_seconds + ? WHERE id = ?').bind(seconds, userId),
    env.DB.prepare(
      `INSERT INTO usage_ledger (user_id, room_id, seconds, reason, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(userId, roomId, -seconds, reason, now),
  ]);
}

// Deduct up to `seconds` from a user's balance. Returns the actual deducted
// amount (clamped to non-negative balance). Best-effort atomicity via a
// conditional update + a separate clamp read.
export async function deductBalance(env, userId, seconds, roomId = null, reason = 'room') {
  if (!(seconds > 0)) return 0;
  const now = Date.now();
  // Use UPDATE ... WHERE balance_seconds >= ? to deduct fully, else partial.
  const full = await env.DB.prepare(
    `UPDATE users SET balance_seconds = balance_seconds - ? WHERE id = ? AND balance_seconds >= ?`
  ).bind(seconds, userId, seconds).run();
  let actual = 0;
  if (full.success && full.meta.changes > 0) {
    actual = seconds;
  } else {
    // Partial: take whatever remains.
    const row = await env.DB.prepare('SELECT balance_seconds FROM users WHERE id = ?').bind(userId).first();
    const remaining = Number(row?.balance_seconds || 0);
    if (remaining > 0) {
      await env.DB.prepare('UPDATE users SET balance_seconds = 0 WHERE id = ?').bind(userId).run();
      actual = remaining;
    }
  }
  if (actual > 0) {
    await env.DB.prepare(
      `INSERT INTO usage_ledger (user_id, room_id, seconds, reason, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(userId, roomId, actual, reason, now).run();
  }
  return actual;
}

export async function recentUsage(env, userId, limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT room_id, seconds, reason, created_at FROM usage_ledger
      WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).bind(userId, limit).all();
  return results || [];
}
