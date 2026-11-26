// Turns a short phrase (typed in Telegram or spoken on the glasses) into an
// intent. A fixed grammar, not a model: what you say is what gets confirmed.
//
//   buy 0.01 eth · long 0.01 eth · sell 0.02 eth · short 0.02 eth
//   close eth
//   supply 50 usdc · deposit 50 · withdraw 20 usdc · withdraw all
//   swap 10 usdc to eth · swap 0.001 eth for usdc
//   status · positions
//   yes · confirm · no · cancel

const ONES = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1000 };

const ASSETS = [
  [/^(eth|ether|ethereum|weth|e t h)$/, 'ETH'],
  [/^(btc|bitcoin|b t c)$/, 'BTC'],
  [/^(sol|solana)$/, 'SOL'],
  [/^(usdc|usd c|u s d c|dollars?|usd|bucks)$/, 'USDC'],
];

/** Speech-to-text output and typed text into lowercase words, numbers kept. */
export function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/\$\s*([\d.]+)/g, '$1 usdc')
    .replace(/u\.?s\.?d\.?c\.?/g, 'usdc')
    .replace(/e\.?t\.?h\.?(?![a-z])/g, 'eth')
    .replace(/[^a-z0-9.\s]/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Spoken numbers ("zero point zero one", "fifty", "two hundred") into digits. */
export function wordsToNumbers(words) {
  const out = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (!(w in ONES || w in TENS || w === 'point' || w === 'a' && SCALES[words[i + 1]])) { out.push(w); i++; continue; }
    if (w === 'point' && !/^\d/.test(out.at(-1) ?? '')) { out.push(w); i++; continue; }
    // Integer part
    let total = 0, cur = 0, took = 0;
    while (i < words.length) {
      const x = words[i];
      if (x in ONES) cur += ONES[x];
      else if (x in TENS) cur += TENS[x];
      else if (x === 'a' && SCALES[words[i + 1]]) cur += 1;
      else if (x in SCALES && (cur || took)) { cur = (cur || 1) * SCALES[x]; if (x === 'thousand') { total += cur; cur = 0; } }
      else if (x === 'and' && took && (words[i + 1] in ONES || words[i + 1] in TENS)) {}
      else break;
      took++; i++;
    }
    let num = took ? String(total + cur) : out.pop();
    // Decimal part: each digit word after "point"
    if (words[i] === 'point') {
      let digits = '';
      let j = i + 1;
      while (j < words.length && (words[j] in ONES && ONES[words[j]] < 10 || /^\d$/.test(words[j]))) {
        digits += /^\d$/.test(words[j]) ? words[j] : ONES[words[j]];
        j++;
      }
      if (digits) { num = `${num ?? '0'}.${digits}`; i = j; }
    }
    if (num !== undefined) out.push(num);
    if (!took && words[i] !== 'point') i++;
  }
  return out;
}

const asset = (w) => ASSETS.find(([re]) => re.test(w ?? ''))?.[1];
const isNum = (w) => /^\d+(\.\d+)?$|^\.\d+$/.test(w ?? '');
const num = (w) => (w.startsWith('.') ? '0' + w : w);

/** The first number in `ws` and the asset named right after (or anywhere) it. */
function amountAndAsset(ws) {
  const i = ws.findIndex(isNum);
  if (i < 0) return {};
  const joined = ws.slice(i + 1).join(' ');
  const a = asset(ws[i + 1]) ?? asset(joined.split(' ').slice(0, 3).join(' ')) ?? ws.map(asset).find(Boolean);
  return { amount: num(ws[i]), asset: a };
}

/**
 * @returns {{ kind: string, [k: string]: any } | null} null when nothing matched
 */
export function parse(text) {
  const ws = wordsToNumbers(normalize(text).split(' ').filter(Boolean));
  const s = ' ' + ws.join(' ') + ' ';
  const has = (re) => re.test(s);

  if (has(/^ (yes|yeah|yep|confirm|confirmed|do it|go|ok|okay|approve) $/)) return { kind: 'yes' };
  if (has(/^ (no|nope|cancel|stop|never mind|nevermind|abort) $/)) return { kind: 'no' };

  if (has(/ (close|exit|flatten) /)) {
    const a = ws.map(asset).find(Boolean) ?? 'ETH';
    return { kind: 'hl_close', coin: a };
  }
  if (has(/ (swap|convert|exchange|trade) /) && (has(/ (to|for|into) /))) {
    const i = ws.findIndex((w) => ['to', 'for', 'into'].includes(w));
    const { amount, asset: from } = amountAndAsset(ws.slice(0, i));
    const to = ws.slice(i + 1).map(asset).find(Boolean);
    if (!amount || !from || !to || from === to) return null;
    return { kind: 'swap', amount, from, to };
  }
  if (has(/ (supply|deposit|lend|save) /)) {
    const { amount } = amountAndAsset(ws);
    return amount ? { kind: 'aave_supply', amount } : null;
  }
  if (has(/ (withdraw|take out|redeem) /)) {
    if (has(/ (all|everything|max) /)) return { kind: 'aave_withdraw', amount: 'all' };
    const { amount } = amountAndAsset(ws);
    return amount ? { kind: 'aave_withdraw', amount } : null;
  }
  const buy = has(/ (buy|long|go long) /), sell = has(/ (sell|short|go short) /);
  if (buy !== sell) {
    const { amount, asset: a } = amountAndAsset(ws);
    if (!amount || (a && a === 'USDC')) return null;
    return { kind: 'hl_order', side: buy ? 'buy' : 'sell', size: amount, coin: a ?? 'ETH' };
  }
  if (has(/ (status|positions?|portfolio|how am i doing|summary|balance|balances) /)) return { kind: 'status' };
  return null;
}

/** The intent in a few words, for the confirm screen (glasses fit about 30 characters a line). */
export function describe(i) {
  switch (i.kind) {
    case 'hl_order': return `${i.side === 'buy' ? 'Buy' : 'Sell'} ${i.size} ${i.coin} perp`;
    case 'hl_close': return `Close ${i.coin} position`;
    case 'aave_supply': return `Supply ${i.amount} USDC to Aave`;
    case 'aave_withdraw': return i.amount === 'all' ? 'Withdraw all USDC from Aave' : `Withdraw ${i.amount} USDC from Aave`;
    case 'swap': return `Swap ${i.amount} ${i.from} to ${i.to}`;
    default: return i.kind;
  }
}
