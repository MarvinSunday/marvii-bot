// A small JSON-file store: linked users, glasses pairings. Enough for a
// hackathon deployment with one process; swap for a database to scale.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';

const empty = () => ({ users: {}, devices: {}, codes: {} });
let db = empty();
try {
  db = { ...empty(), ...JSON.parse(fs.readFileSync(config.dataFile, 'utf8')) };
} catch {}

let saving = null;
function save() {
  // Coalesce writes; write to a temp file and rename so a crash never leaves half a file.
  saving ??= setTimeout(() => {
    saving = null;
    fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
    const tmp = config.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, config.dataFile);
  }, 200);
}

export const DEFAULT_ALERTS = { healthBelow: 1.3, pnlMovePct: 5, liqDistancePct: 10 };

/** A Telegram user's record, created on first contact. */
export function user(tgId) {
  const id = String(tgId);
  if (!db.users[id]) {
    // key_id: the grant's name on the wallet. Random, so a return link can't be guessed.
    db.users[id] = { id, keyId: 'marvii-bot-' + crypto.randomBytes(5).toString('hex'), wallet: null, evm: null, watch: [], alerts: { ...DEFAULT_ALERTS }, seen: {} };
    save();
  }
  return db.users[id];
}

export function update(tgId, patch) {
  Object.assign(user(tgId), patch);
  save();
  return user(tgId);
}

export const allLinked = () => Object.values(db.users).filter((u) => u.wallet);
export const byKeyId = (keyId) => Object.values(db.users).find((u) => u.keyId === keyId);

// ---- Glasses pairing: the glasses app shows a 6-digit code, the user sends /pair <code> in Telegram.

const CODE_TTL = 10 * 60_000;

/** A new device token and its pairing code. */
export function newPairing() {
  const token = crypto.randomBytes(24).toString('base64url');
  let code;
  do code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  while (db.codes[code]);
  db.codes[code] = { token, at: Date.now() };
  db.devices[token] = { user: null, at: Date.now() };
  save();
  return { token, code };
}

/** Links the device behind `code` to a Telegram user. */
export function pair(code, tgId) {
  const c = db.codes[code];
  if (!c || Date.now() - c.at > CODE_TTL) return false;
  delete db.codes[code];
  db.devices[c.token] = { user: String(tgId), at: Date.now() };
  save();
  return true;
}

/** The Telegram user a device token belongs to, if paired. */
export function deviceUser(token) {
  const d = token && db.devices[token];
  return d?.user ? user(d.user) : null;
}

export function unpairAll(tgId) {
  for (const [t, d] of Object.entries(db.devices)) if (d.user === String(tgId)) delete db.devices[t];
  save();
}
