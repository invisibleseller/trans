#!/usr/bin/env node
// Generate redemption codes and insert into the D1 database via wrangler.
//
// Usage:
//   node scripts/gen-codes.mjs --minutes 30 --count 10 --label "30min ¥88" [--batch 2025-01-A] [--local]
//
// What it does:
//   1. Generates N random alphanumeric codes (e.g. RTI-XXXX-XXXX-XXXX).
//   2. Writes a temp .sql file with INSERT statements.
//   3. Runs `npx wrangler d1 execute realtime-interp-db --file=<tmp>` against
//      remote D1 (or --local for the local dev DB).
//   4. Prints the codes to stdout, one per line. Save them somewhere safe and
//      hand them out to paying users.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, exit } from 'node:process';

const args = parseArgs(argv.slice(2));
const minutes = Number(args.minutes);
const count = Number(args.count || 1);
const label = args.label || `${minutes}min`;
const batch = args.batch || new Date().toISOString().slice(0, 10);
const dbName = args.db || 'realtime-interp-db';
const local = !!args.local;

if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error('--minutes is required, must be > 0');
  exit(2);
}
if (!Number.isFinite(count) || count <= 0 || count > 10000) {
  console.error('--count must be between 1 and 10000');
  exit(2);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

function genCode() {
  const blocks = [];
  for (let g = 0; g < 3; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    blocks.push(s);
  }
  return 'RTI-' + blocks.join('-');
}

function sqlEsc(s) { return String(s).replace(/'/g, "''"); }

const codes = new Set();
while (codes.size < count) codes.add(genCode());

const seconds = minutes * 60;
const now = Date.now();

const stmts = [...codes].map((c) =>
  `INSERT INTO redemption_codes (code, seconds, label, batch, created_at) VALUES ('${sqlEsc(c)}', ${seconds}, '${sqlEsc(label)}', '${sqlEsc(batch)}', ${now});`
).join('\n');

const dir = mkdtempSync(join(tmpdir(), 'rti-codes-'));
const file = join(dir, 'codes.sql');
writeFileSync(file, stmts);

const wranglerArgs = ['wrangler', 'd1', 'execute', dbName, '--file', file];
if (local) wranglerArgs.push('--local');
else wranglerArgs.push('--remote');

try {
  execFileSync('npx', wranglerArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n# Generated codes (' + codes.size + ' × ' + minutes + ' min · "' + label + '" · batch=' + batch + '):');
for (const c of codes) console.log(c);

function parseArgs(arr) {
  const out = {};
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = arr[i + 1];
      if (next === undefined || next.startsWith('--')) { out[k] = true; }
      else { out[k] = next; i++; }
    }
  }
  return out;
}
