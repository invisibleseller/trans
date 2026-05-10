// Redemption code logic. Code generation is handled by scripts/gen-codes.mjs;
// this module just handles redemption from the user side.

import { addBalance } from './db.js';

export async function redeemCode(env, userId, rawCode) {
  const code = String(rawCode || '').toUpperCase().trim();
  if (!code) return { ok: false, error: 'empty' };
  const row = await env.DB.prepare(
    'SELECT code, seconds, label, redeemed_at FROM redemption_codes WHERE code = ?'
  ).bind(code).first();
  if (!row) return { ok: false, error: 'invalid' };
  if (row.redeemed_at) return { ok: false, error: 'used' };

  // Atomic claim: only succeeds if not yet redeemed.
  const claim = await env.DB.prepare(
    'UPDATE redemption_codes SET redeemed_at = ?, redeemed_by = ? WHERE code = ? AND redeemed_at IS NULL'
  ).bind(Date.now(), userId, code).run();
  if (!claim.success || claim.meta.changes === 0) {
    return { ok: false, error: 'used' };
  }

  const seconds = Number(row.seconds || 0);
  if (seconds > 0) {
    await addBalance(env, userId, seconds, 'redeem:' + code, null);
  }
  return { ok: true, seconds, label: row.label || null };
}
