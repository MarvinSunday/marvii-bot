// What Telegram and the glasses share: the latest snapshot per user, the
// confirm prompts, what's running, and the alerts.
import { parse, describe } from './parse.mjs';
import { snapshot, glance } from './feeds.mjs';
import { run, promptId } from './marvii.mjs';
import { allLinked, update, user } from './store.mjs';
import { resolve, runPaper, positions } from './paper.mjs';
import { config } from './config.mjs';

/** Things outside core that want to know (the Telegram bot). */
export const hooks = { notify: async (_u, _msg) => {} };

const snaps = new Map(); // user id -> snapshot
const prompts = new Map(); // prompt id -> { user, intent, text, at }
const activity = new Map(); // user id -> { text, waiting?, url?, done?, ok?, links?, at }
const PROMPT_TTL = 2 * 60_000;

export async function refresh(u) {
  if (!u.wallet) return null;
  const s = await snapshot(u);
  s.bets = positions(u, s.markets);
  snaps.set(u.id, s);
  return s;
}

export async function lines(u, { fresh = false } = {}) {
  let s = snaps.get(u.id);
  if (fresh || !s || Date.now() - s.at > config.pollMs) s = await refresh(u);
  return s ? glance(s) : [];
}

export const latest = (u) => snaps.get(u.id);
export const currentActivity = (u) => activity.get(u.id) ?? null;
export const openPrompt = (u) => [...prompts.entries()].find(([, p]) => p.user === u.id && Date.now() - p.at < PROMPT_TTL)?.[0] ?? null;
export const promptText = (id) => prompts.get(id)?.text;

/**
 * Handles a phrase from either screen. Returns what to show:
 *   { kind: 'prompt', id, text }   an action to confirm
 *   { kind: 'status', lines }
 *   { kind: 'confirmed' | 'cancelled' } for yes/no while a prompt is open
 *   { kind: 'unknown', text }
 */
export async function ask(u, phrase) {
  const i = parse(phrase);
  if (!i) return { kind: 'unknown', text: `Didn't catch that: "${phrase}". Try "buy 0.01 eth" or "status".` };
  if (i.kind === 'status') return { kind: 'status', lines: await lines(u, { fresh: true }) };
  if (i.kind === 'yes' || i.kind === 'no') {
    const id = openPrompt(u);
    if (!id) return { kind: 'unknown', text: 'Nothing to confirm.' };
    confirm(id, i.kind === 'yes');
    return { kind: i.kind === 'yes' ? 'confirmed' : 'cancelled', id };
  }
  if (!u.wallet) return { kind: 'unknown', text: 'Link your Marvii wallet first: /start in Telegram.' };
  let intent = i;
  if (i.kind.startsWith('pm_')) {
    const r = await resolve(u, i);
    if (r.error) return { kind: 'unknown', text: r.error, reason: r.error };
    intent = r.intent;
  }
  // One open prompt per user: a new request replaces the old one.
  for (const [k, p] of prompts) if (p.user === u.id) prompts.delete(k);
  const id = promptId();
  const text = describe(intent) + '?';
  prompts.set(id, { user: u.id, intent, text, at: Date.now() });
  // Telegram also shows which market a paper bet is on; the glasses title has room for the short text only.
  return { kind: 'prompt', id, text, detail: intent.question };
}

/** Yes or no on a prompt. Runs the action in the background; progress and the result go to both screens. */
export function confirm(id, yes) {
  const p = prompts.get(id);
  if (!p || Date.now() - p.at > PROMPT_TTL) return false;
  prompts.delete(id);
  const u = user(p.user);
  if (!yes) {
    activity.set(u.id, { text: 'Cancelled', done: true, ok: false, at: Date.now() });
    return true;
  }
  const title = p.text.replace(/\?$/, '');
  activity.set(u.id, { text: `${title}…`, at: Date.now() });
  hooks.notify(u, { text: `⏳ ${title}…` });
  const job = p.intent.kind.startsWith('pm_') ? runPaper(u, p.intent) : run(u, p.intent, (step) => {
    activity.set(u.id, { ...step, at: Date.now() });
    if (step.waiting) hooks.notify(u, { text: `🔐 ${step.text}`, url: step.url, button: 'Approve with passkey' });
  });
  job.catch((e) => ({ ok: false, text: e.message })).then((r) => {
    activity.set(u.id, { text: r.text, done: true, ok: r.ok, links: r.links, at: Date.now() });
    hooks.notify(u, { text: `${r.ok ? '✅' : '⛔'} ${r.text}`, links: r.links });
    refresh(u).catch(() => {});
  });
  return true;
}

// ---- Alerts: checked every poll, sent once per crossing.

export function alertsFor(u, s) {
  const out = [];
  const a = u.alerts ?? {};
  for (const p of s.hl?.positions ?? []) {
    if (p.liqDistancePct !== null && p.liqDistancePct < a.liqDistancePct) out.push({ key: `liq:${p.coin}`, text: `${p.coin} ${p.side} is ${p.liqDistancePct.toFixed(1)}% from liquidation (${p.liq})` });
    const bucket = Math.trunc(p.roe / a.pnlMovePct);
    if (bucket !== 0) out.push({ key: `pnl:${p.coin}:${bucket}`, text: `${p.coin} ${p.side} ${p.roe >= 0 ? 'up' : 'down'} ${Math.abs(p.roe).toFixed(1)}% (${p.pnl >= 0 ? '+' : '-'}$${Math.abs(p.pnl).toFixed(2)})` });
  }
  if (s.aave?.health !== null && s.aave?.health !== undefined && s.aave.health < a.healthBelow) out.push({ key: 'aave:health', text: `Aave health ${s.aave.health.toFixed(2)}, below ${a.healthBelow}` });
  for (const m of s.markets) {
    const top = [...m.outcomes].sort((x, y) => y.pct - x.pct)[0];
    out.push({ key: `pm:${m.slug}:${Math.round(top.pct / 5)}`, quiet: true, text: `${m.question}: ${top.name} ${top.pct}%` });
  }
  // Paper bets: every 20% move in value, and once when the market settles.
  for (const b of s.bets ?? []) {
    const k = `${b.slug}/${b.outcome}`;
    if (b.closed) out.push({ key: `betdone:${k}:1`, text: `Settled: ${b.question}. Your paper ${b.outcome} bet is worth $${b.value.toFixed(2)} (${b.pnl >= 0 ? '+' : '-'}$${Math.abs(b.pnl).toFixed(2)}).` });
    const bucket = Math.trunc(b.pnlPct / 20);
    if (bucket !== 0 && !b.closed) out.push({ key: `bet:${k}:${bucket}`, text: `Paper ${b.outcome} bet ${b.pnl >= 0 ? 'up' : 'down'} ${Math.abs(b.pnlPct).toFixed(0)}% (${b.pnl >= 0 ? '+' : '-'}$${Math.abs(b.pnl).toFixed(2)}): ${b.question}` });
  }
  return out;
}

async function poll() {
  for (const u of allLinked()) {
    try {
      const s = await refresh(u);
      const seen = u.seen ?? {};
      const fired = alertsFor(u, s);
      const keys = new Set(fired.map((f) => f.key.split(':').slice(0, 2).join(':')));
      for (const f of fired) {
        const family = f.key.split(':').slice(0, 2).join(':');
        if (seen[family] === f.key) continue;
        const first = !(family in seen);
        seen[family] = f.key;
        // Odds: no message for the first reading, only for moves.
        if (!(f.quiet && first)) hooks.notify(u, { text: `🔔 ${f.text}` });
      }
      // A condition that cleared can fire again later.
      for (const fam of Object.keys(seen)) if (!keys.has(fam)) delete seen[fam];
      update(u.id, { seen });
    } catch (e) {
      console.error(`poll ${u.id}: ${e.message}`);
    }
  }
}

export function startPolling() {
  const tick = () => poll().finally(() => setTimeout(tick, config.pollMs));
  setTimeout(tick, 2000);
}
