// Polymarket paper bets: recorded at the live price, valued at the live price.
// No money moves and nothing is signed. Polymarket runs on mainnet only, so
// the hackathon demo bets on paper (its rules allow testnet, paper or read-only).
import { polymarket } from './feeds.mjs';
import { update } from './store.mjs';

export const MAX_STAKE = 1000;

/** Picks the market a phrase means: one named by a word ("for nvidia"), or the only candidate. */
async function pick(slugs, about) {
  const markets = (await Promise.all(slugs.map((s) => polymarket(s).catch(() => null)))).filter(Boolean);
  if (!markets.length) return null;
  const named = about.length ? markets.filter((m) => about.some((w) => m.question.toLowerCase().includes(w) || m.slug.includes(w))) : [];
  if (named.length === 1) return named[0];
  return markets.length === 1 ? markets[0] : 'ambiguous';
}

const outcomeOf = (m, word) => m.outcomes.find((o) => o.name.toLowerCase() === word) ?? m.outcomes.find((o) => o.name.toLowerCase().startsWith(word));

/** Fills a parsed pm_bet or pm_close with its market and live price. Returns { intent } or { error }. */
export async function resolve(u, i) {
  if (i.kind === 'pm_bet') {
    if (Number(i.amount) > MAX_STAKE) return { error: `Paper bets go up to $${MAX_STAKE}.` };
    if (!u.watch?.length) return { error: 'Follow a market first: /watch <polymarket link> in Telegram.' };
    const m = await pick(u.watch, i.about);
    if (!m) return { error: "Couldn't read Polymarket. Try again in a moment." };
    if (m === 'ambiguous') return { error: 'Which market? Add a word from its question, like "bet 10 on yes for nvidia".' };
    if (m.closed) return { error: 'That market has closed.' };
    const o = outcomeOf(m, i.outcome);
    if (!o) return { error: `That market's outcomes are ${m.outcomes.map((x) => x.name).join(' and ')}.` };
    if (o.price < 0.01 || o.price > 0.99) return { error: `${o.name} is at ${o.pct}%: too close to settled to bet on.` };
    return { intent: { ...i, slug: m.slug, question: m.question, outcome: o.name, pct: o.pct } };
  }
  const bets = u.bets ?? [];
  if (!bets.length) return { error: 'No paper bets open.' };
  const m = await pick([...new Set(bets.map((b) => b.slug))], i.about);
  if (!m) return { error: "Couldn't read Polymarket. Try again in a moment." };
  if (m === 'ambiguous') return { error: 'Which bet? Add a word from the question, like "cash out nvidia".' };
  const mine = bets.filter((b) => b.slug === m.slug);
  const value = mine.reduce((s, b) => s + b.shares * (m.outcomes.find((o) => o.name === b.outcome)?.price ?? 0), 0);
  const names = [...new Set(mine.map((b) => b.outcome))];
  return { intent: { ...i, slug: m.slug, question: m.question, outcome: names.length === 1 ? names[0] : undefined, value } };
}

/** Runs a confirmed paper bet or cash-out, at the price at that moment. */
export async function runPaper(u, i) {
  const m = await polymarket(i.slug);
  if (!m) return { ok: false, text: "Couldn't read Polymarket. Nothing recorded." };
  if (i.kind === 'pm_bet') {
    const o = m.outcomes.find((x) => x.name === i.outcome);
    if (m.closed || !o || o.price < 0.01 || o.price > 0.99) return { ok: false, text: 'The market moved to settled. Nothing recorded.' };
    const stake = Number(i.amount);
    update(u.id, { bets: [...(u.bets ?? []), { slug: m.slug, question: m.question, outcome: o.name, price: o.price, stake, shares: stake / o.price, at: Date.now() }] });
    return { ok: true, text: `Paper bet: $${stake} on ${o.name} at ${o.pct}% (${m.question}). Pays $${(stake / o.price).toFixed(2)} if ${o.name} wins.`, links: [{ label: 'Market on Polymarket', url: `https://polymarket.com/market/${m.slug}` }] };
  }
  const mine = (u.bets ?? []).filter((b) => b.slug === m.slug);
  if (!mine.length) return { ok: false, text: 'No paper bet on that market.' };
  const stake = mine.reduce((s, b) => s + b.stake, 0);
  const value = mine.reduce((s, b) => s + b.shares * (m.outcomes.find((o) => o.name === b.outcome)?.price ?? 0), 0);
  update(u.id, { bets: u.bets.filter((b) => b.slug !== m.slug), paperPnl: (u.paperPnl ?? 0) + value - stake });
  const pnl = value - stake;
  return { ok: true, text: `Cashed out on paper: $${value.toFixed(2)} for $${stake.toFixed(2)} staked (${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}). ${m.question}` };
}

/** Open bets valued at the snapshot's prices: one entry per market and outcome. */
export function positions(u, markets) {
  const out = new Map();
  for (const b of u.bets ?? []) {
    const m = markets.find((x) => x.slug === b.slug);
    const price = m?.outcomes.find((o) => o.name === b.outcome)?.price;
    if (price === undefined) continue;
    const k = `${b.slug}/${b.outcome}`;
    const p = out.get(k) ?? { slug: b.slug, question: b.question, outcome: b.outcome, stake: 0, value: 0, closed: m.closed };
    p.stake += b.stake;
    p.value += b.shares * price;
    out.set(k, p);
  }
  return [...out.values()].map((p) => ({ ...p, pnl: p.value - p.stake, pnlPct: (p.value / p.stake - 1) * 100 }));
}
