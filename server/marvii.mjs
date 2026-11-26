// Acting through a Marvii wallet. The bot holds no wallet keys: its session
// key lives in Marvii's OutLayer module (Intel TDX), each request goes to
// Marvii's extension on NEAR, and the extension checks it against the grant
// the owner's passkey signed before NEAR's Chain Signatures sign anything.
// Over a daily limit, an EVM request waits for the owner's passkey.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  encodeFunctionData, keccak256, serializeTransaction, recoverTransactionAddress,
  recoverAddress, parseAbi, toFunctionSelector, parseUnits, formatUnits, getAddress,
} from 'viem';
import { config } from './config.mjs';
import { OutLayerSigner, LocalSigner, MarviiAgent, permissionLink, evmTx, hlOrder, hlLeverage } from './vendor/marvii-sdk.mjs';
import { evm, erc20, pool, AAVE_POOL, USDC, WETH, hlMarkets, hlMids, hlState } from './feeds.mjs';

const CHAIN_ID = 84532; // Base Sepolia
/** The perps markets the bot asks for. */
export const HL_COINS = ['ETH', 'BTC'];
/** Hyperliquid's smallest order, in USD. */
export const HL_MIN_USD = 10;
// Uniswap V3 on Base Sepolia: SwapRouter02 and QuoterV2, checked on-chain in
// near/agent/agent.mjs (factory() is the Uniswap V3 factory, WETH9() is WETH).
const ROUTER = '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4';
const QUOTER = '0xc5290058841028f1614f3a6f0f5816cad0df5e27';
const FEE = 3000;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// Marvii's OutLayer module, the latest build the wallet page accepts
// (near/web TEE_MODULES), published on FastFS by its tee-operator account.
const MODULE_HASH = 'd6de908f4e974eaa1205a2523d05ccd31ac6a448694dac5313ebd30eab1d8543';
const MODULE_URL = `https://test.fastfs.io/8f58bd6605569e82eb7002c9ada7f038959a961c10d77d0aa754a708c519d804/outlayer.testnet/${MODULE_HASH}.wasm`;

const uni = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160, uint32, uint256)',
]);
const weth = parseAbi(['function deposit() payable', 'function withdraw(uint256 wad)']);
const sel = (sig) => toFunctionSelector(sig);

// ---------------------------------------------------------------- signer ----

let signer = null;
/** The bot's one session key. Every linked wallet grants this key, under its own key_id. */
export function getSigner() {
  if (signer) return signer;
  if (config.localSeed) return (signer = new LocalSigner(config.localSeed));
  const { operator, operatorKey, moduleHash, moduleUrl } = config.outlayer;
  if (!operator || !operatorKey) throw new Error('set OUTLAYER_OPERATOR and OUTLAYER_OPERATOR_KEY (or LOCAL_AGENT_SEED for local tests)');
  return (signer = new OutLayerSigner({
    moduleHash: moduleHash ?? MODULE_HASH,
    moduleUrl: moduleUrl ?? MODULE_URL,
    operator: { accountId: operator, privateKey: operatorKey },
  }));
}

let publicKey = null, keyProof = null;
/**
 * The TEE key's public half and the OutLayer run that made it. Asking takes
 * an OutLayer run (often a minute or more), so the answer is kept on disk for
 * this operator and module. It's public: the run is on NEAR for anyone to check.
 */
export async function agentPublicKey() {
  const s = getSigner();
  if (publicKey) return { publicKey, keyProof };
  if (s instanceof LocalSigner) return { publicKey: (publicKey = s.publicKey), keyProof: null };
  const file = path.join(path.dirname(config.dataFile), 'agent-key.json');
  const id = `${config.outlayer.operator}/${s.o.moduleHash}`;
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.id === id) {
      s.publicKey = c.publicKey; s.keyProof = c.keyProof;
      return { publicKey: (publicKey = c.publicKey), keyProof: (keyProof = c.keyProof) };
    }
  } catch {}
  publicKey = await s.getPublicKey();
  keyProof = s.keyProof;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id, publicKey, keyProof }));
  return { publicKey, keyProof };
}

// ----------------------------------------------------------------- grant ----

/** What Marvii bot asks each wallet for. The page shows all of it in plain words. */
export async function grant() {
  const m = await hlMarkets();
  return {
    evm_self: '{evm_self}',
    evm_venues: [
      { chain_id: CHAIN_ID, to: AAVE_POOL, selector: sel('function supply(address,uint256,address,uint16)') },
      { chain_id: CHAIN_ID, to: AAVE_POOL, selector: sel('function withdraw(address,uint256,address)') },
      { chain_id: CHAIN_ID, to: ROUTER, selector: sel('function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))') },
      { chain_id: CHAIN_ID, to: WETH, selector: sel('function deposit()') },
      // Unwrap: WETH pays the ETH back to the caller, the account itself.
      { chain_id: CHAIN_ID, to: WETH, selector: sel('function withdraw(uint256)') },
    ],
    hl_markets: HL_COINS.filter((c) => m[c]).map((c) => ({ asset: m[c].asset, max_leverage: Math.min(config.hlMaxLeverage, m[c].maxLeverage) })),
    caps: [
      { asset: 'hyperliquid:usd', daily: String(2_000n * 10n ** 6n) },
      { asset: `evm:${CHAIN_ID}:${USDC}`, daily: String(500n * 10n ** 6n) },
      { asset: `evm:${CHAIN_ID}:${WETH}`, daily: String(parseUnits('0.2', 18)) },
      { asset: `evm:${CHAIN_ID}`, daily: String(parseUnits('0.2', 18)) },
    ],
  };
}

/** The link a user opens to give Marvii bot its limits, approved with their passkey. */
export async function linkFor(u, returnUrl) {
  const { publicKey, keyProof } = await agentPublicKey();
  return permissionLink({
    publicKey, keyProof, keyId: u.keyId,
    app: { name: 'Marvii bot', url: config.publicUrl },
    grant: await grant(), days: 30, idleDays: 14,
    returnUrl, page: config.marvii.page,
  });
}

const agents = new Map();
export function agentFor(u) {
  const k = `${u.wallet}/${u.keyId}`;
  if (!agents.has(k)) agents.set(k, new MarviiAgent({ wallet: u.wallet, keyId: u.keyId, signer: getSigner(), relayer: config.marvii.relayer }));
  return agents.get(k);
}

/**
 * Checks on NEAR that `wallet` granted our key under the user's key_id, and
 * returns its EVM address from the grant. Used after the permission link
 * returns, so a forged return URL links nothing.
 */
export async function verifyLink(u, wallet) {
  const { publicKey } = await agentPublicKey();
  const a = new MarviiAgent({ wallet, keyId: u.keyId, signer: getSigner(), relayer: config.marvii.relayer });
  const s = await a.session();
  if (!s || s.revoked || s.grant.public_key !== publicKey) return null;
  return { evm: getAddress(s.grant.evm_self), expiresAt: s.grant.expires_at_ms };
}

// ------------------------------------------------------------ execution ----

// One action at a time per wallet: each signed message uses the session's next nonce.
const locks = new Map();
function serial(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

const explorer = (h) => `https://sepolia.basescan.org/tx/${h}`;
const nearTx = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const approvalUrl = () => `${config.marvii.page}/#/agents`;

function rsv(sig) {
  const r = BigInt('0x' + sig.big_r.affine_point.slice(2));
  let s = BigInt('0x' + sig.s.scalar), yParity = sig.recovery_id;
  if (s > SECP_N / 2n) { s = SECP_N - s; yParity ^= 1; } // low S
  return { r: '0x' + r.toString(16).padStart(64, '0'), s: '0x' + s.toString(16).padStart(64, '0'), yParity };
}

class Refused extends Error {}

/** One EVM transaction from the wallet's address: signed by Chain Signatures after the extension's check, then sent. */
async function sendEvm(u, { to, data, value = 0n }, progress) {
  const agent = agentFor(u);
  const from = u.evm;
  const [nonce, block, prio, gas] = await Promise.all([
    evm.getTransactionCount({ address: from, blockTag: 'pending' }),
    evm.getBlock(),
    evm.estimateMaxPriorityFeePerGas(),
    evm.estimateGas({ account: from, to, data, value }).catch(() => 250_000n),
  ]);
  const unsigned = { type: 'eip1559', chainId: CHAIN_ID, nonce, to, value, data, maxPriorityFeePerGas: prio, maxFeePerGas: block.baseFeePerGas * 2n + prio, gas: (gas * 12n) / 10n };
  const out = await agent.execute(evmTx({
    chain_id: CHAIN_ID, nonce, to, data, value: value.toString(), gas_limit: Number(unsigned.gas),
    max_priority_fee_per_gas: prio.toString(), max_fee_per_gas: unsigned.maxFeePerGas.toString(),
  }));
  let sig = out.mpc_signature;
  if (!sig) {
    if (!out.pending_id) throw new Refused(out.reason ?? out.error ?? 'refused');
    // Over a daily limit: the owner approves this exact transaction with the passkey.
    progress?.({ waiting: true, text: 'Over your daily limit. Approve on your phone.', url: approvalUrl(), pendingId: out.pending_id });
    const p = await agent.waitForOwner(out.pending_id);
    if (p.status !== 'approved') throw new Refused('you declined it');
    sig = p.mpc_signature;
  }
  // The signature must be over this exact transaction from the account's own address.
  const hash = keccak256(serializeTransaction(unsigned));
  if (out.evm_signing_hash && hash.slice(2) !== out.evm_signing_hash) throw new Error('signing hash mismatch');
  const signed = serializeTransaction(unsigned, rsv(sig));
  if ((await recoverTransactionAddress({ serializedTransaction: signed })) !== from) throw new Error('signature is not from the account');
  const txHash = await evm.sendRawTransaction({ serializedTransaction: signed });
  const rc = await evm.waitForTransactionReceipt({ hash: txHash });
  if (rc.status !== 'success') throw new Error(`reverted: ${explorer(txHash)}`);
  return { hash: txHash, url: explorer(txHash), near: out.tx_hash && nearTx(out.tx_hash) };
}

/** Approves `spender` for `amount` of `token` only if the allowance is short (the approval counts against the daily limit). */
async function ensureAllowance(u, token, spender, amount, progress) {
  const have = await evm.readContract({ address: token, abi: erc20, functionName: 'allowance', args: [u.evm, spender] });
  if (have >= amount) return null;
  progress?.({ text: 'Approving…' });
  return sendEvm(u, { to: token, data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [spender, amount] }) }, progress);
}

// ---- Hyperliquid

/** Hyperliquid's number format: no trailing zeros. */
const hlNum = (x) => {
  const s = String(x);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
/** A price Hyperliquid accepts for a perp: at most 5 significant figures and 6 − szDecimals decimals. */
export function hlPrice(p, szDecimals) {
  const sig = Number(p.toPrecision(5));
  return hlNum(sig.toFixed(Math.max(0, 6 - szDecimals)));
}
export const hlSize = (s, szDecimals) => hlNum(Number(s).toFixed(szDecimals));

async function sendHl(u, action) {
  const agent = agentFor(u);
  const out = await agent.execute(action);
  if (!out.ok || !out.mpc_signature) throw new Refused(out.reason ?? out.error ?? 'refused');
  // The digest the extension had signed, from its own view; the signature must recover to the account.
  const cfg = agent.cfg;
  const digest = '0x' + (await agent.view(cfg.extension, 'hl_signing_hash', { action }));
  const { r, s, yParity } = rsv(out.mpc_signature);
  if ((await recoverAddress({ hash: digest, signature: { r, s, yParity } })) !== u.evm) throw new Error('signature is not from the account');
  const wire = action.type === 'hl_order'
    ? { type: 'order', orders: [{ a: action.asset, b: action.is_buy, p: action.price, s: action.size, r: action.reduce_only, t: { limit: { tif: action.tif } } }], grouping: 'na' }
    : { type: 'updateLeverage', asset: action.asset, isCross: action.is_cross, leverage: action.leverage };
  const res = await fetch(`${config.hyperliquid}/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: wire, nonce: action.nonce, signature: { r, s, v: 27 + yParity }, vaultAddress: null }),
  }).then((x) => x.json());
  if (res.status !== 'ok') throw new Error(`Hyperliquid: ${typeof res.response === 'string' ? res.response : JSON.stringify(res)}`);
  const st = res.response?.data?.statuses?.[0];
  if (st?.error) throw new Error(`Hyperliquid: ${st.error}`);
  return { filled: st?.filled, near: out.tx_hash && nearTx(out.tx_hash) };
}

const grantCache = new Map(); // wallet/keyId -> { at, max: { ETH: 3, … } }
/** The highest leverage the user's grant allows on each market, read from the session on NEAR. */
export async function grantLeverage(u) {
  const k = `${u.wallet}/${u.keyId}`;
  const c = grantCache.get(k);
  if (c && Date.now() - c.at < 5 * 60_000) return c.max;
  const s = await agentFor(u).session();
  const byAsset = Object.fromEntries(Object.entries(await hlMarkets()).map(([coin, m]) => [m.asset, coin]));
  const max = Object.fromEntries((s?.grant?.hl_markets ?? []).map((x) => [byAsset[x.asset], x.max_leverage]));
  grantCache.set(k, { at: Date.now(), max });
  return max;
}

/** The account's current leverage on a market (Hyperliquid keeps one per market). */
async function currentLeverage(address, coin) {
  const r = await fetch(`${config.hyperliquid}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'activeAssetData', user: address, coin }) }).then((x) => x.json()).catch(() => null);
  return r?.leverage?.value ?? null;
}

/**
 * Sets the market's leverage when asked, or brings it down to the grant's
 * limit if it's above (Hyperliquid's default can be higher). Cross margin.
 */
async function ensureLeverage(u, coin, m, want, progress) {
  const max = (await grantLeverage(u))[coin];
  if (!max) throw new Refused(`your grant doesn't include ${coin} perps`);
  if (want !== undefined && (want < 1 || want > max)) throw new Refused(`leverage above what the grant allows (${max}x on ${coin})`);
  const now = await currentLeverage(u.evm, coin);
  const target = want ?? (now === null || now > max ? Math.min(max, 3) : null);
  if (target === null || target === now) return now;
  progress?.({ text: `Setting ${coin} leverage to ${target}x…` });
  await sendHl(u, hlLeverage({ asset: m.asset, is_cross: true, leverage: target, nonce: Date.now() }));
  return target;
}

/** A size worth at least `usd` (and Hyperliquid's $10 minimum) at `price`, in the market's lot size. */
export function sizeForUsd(usd, price, szDecimals) {
  const step = 10 ** -szDecimals;
  let s = Math.round(usd / price / step) * step;
  while (s * price < Math.max(usd, HL_MIN_USD) * 0.999) s += step;
  return s;
}

async function hlTrade(u, { coin, isBuy, size, usd, leverage, reduceOnly }, progress) {
  const m = (await hlMarkets())[coin];
  if (!m) throw new Refused(`no ${coin} market on Hyperliquid testnet`);
  const lev = reduceOnly ? null : await ensureLeverage(u, coin, m, leverage, progress);
  const mid = Number((await hlMids())[coin]);
  // A marketable limit order: up to 1% worse than the mid price, the rest cancelled.
  const limit = Number(hlPrice(mid * (isBuy ? 1.01 : 0.99), m.szDecimals));
  if (usd) size = sizeForUsd(Number(usd), Math.min(limit, mid), m.szDecimals);
  const sz = hlSize(size, m.szDecimals);
  if (Number(sz) <= 0) throw new Refused(`that's smaller than the smallest ${coin} size`);
  const r = await sendHl(u, hlOrder({ asset: m.asset, is_buy: isBuy, price: hlNum(String(limit)), size: sz, reduce_only: reduceOnly, tif: 'Ioc', nonce: Date.now() }));
  if (!r.filled) throw new Error('not filled (the price moved more than 1%)');
  const value = Number(r.filled.totalSz) * Number(r.filled.avgPx);
  return {
    text: `${isBuy ? 'Bought' : 'Sold'} ${r.filled.totalSz} ${coin} at ${r.filled.avgPx} ($${value.toFixed(2)}${lev ? `, ${lev}x` : ''})`,
    links: [r.near && { label: 'NEAR check', url: r.near }].filter(Boolean),
  };
}

/**
 * Plain words for what went wrong. The raw message still goes to the log.
 * Patterns: Hyperliquid's and the Marvii extension's own error texts.
 */
export function plainError(msg) {
  const rules = [
    [/minimum value of \$?10|min(imum)? .*\$10/i, "Hyperliquid's smallest order is $10."],
    [/insufficient margin|not enough margin/i, 'Not enough margin on Hyperliquid. Say "move 20 usdc to perps" to add some.'],
    [/leverage above what the grant allows(.*)/i, (m) => `That leverage is more than you approved${m[1] ? ' ' + m[1].trim() : ''}. Send /link to approve more.`],
    [/over the daily cap/i, "That's over today's limit you approved."],
    [/session expired/i, 'Your Marvii link expired. Send /link to renew it.'],
    [/not an allowed venue|spender is not a venue|grant doesn't include/i, "That isn't something you allowed Marvii bot to do. Send /link to update what it may do."],
    [/output_storage_unpaid|OutLayer/i, "Marvii's secure signer didn't answer. Try again in a minute."],
    [/fetch failed|ECONNRESET|ETIMEDOUT|timed? ?out/i, 'A network call failed. Try again in a minute.'],
    [/not filled/i, 'Not filled: the price moved more than 1%. Try again.'],
    [/no open (\w+) position/i, (m) => `You have no open ${m[1]} position.`],
  ];
  for (const [re, t] of rules) {
    const m = re.exec(msg);
    if (m) return typeof t === 'function' ? t(m) : t;
  }
  return msg;
}

// ---- Public: run an intent from parse.mjs

/**
 * Runs an intent for a linked user. `progress({ text, waiting?, url? })` gets
 * updates (e.g. waiting for the passkey). Resolves to
 * `{ ok, text, links: [{ label, url }] }`; never throws.
 */
export function run(u, intent, progress) {
  if (!u.wallet || !u.evm) return Promise.resolve({ ok: false, text: 'Link your Marvii wallet first: /start' });
  return serial(u.wallet, async () => {
    try {
      const r = await runInner(u, intent, progress);
      return { ok: true, links: [], ...r };
    } catch (e) {
      console.error(`run ${intent.kind}: ${e.message}`);
      return { ok: false, text: plainError(e.message), links: [] };
    }
  });
}

async function runInner(u, i, progress) {
  switch (i.kind) {
    case 'hl_order':
      return hlTrade(u, { coin: i.coin, isBuy: i.side === 'buy', size: i.size && Number(i.size), usd: i.usd, leverage: i.leverage, reduceOnly: false }, progress);
    case 'hl_close': {
      const p = (await hlState(u.evm)).positions.find((x) => x.coin === i.coin);
      if (!p) throw new Refused(`no open ${i.coin} position`);
      return hlTrade(u, { coin: i.coin, isBuy: p.size < 0, size: Math.abs(p.size) * (i.fraction ?? 1), reduceOnly: true }, progress);
    }
    case 'hl_leverage': {
      const m = (await hlMarkets())[i.coin];
      if (!m) throw new Refused(`no ${i.coin} market on Hyperliquid testnet`);
      await ensureLeverage(u, i.coin, m, i.leverage, progress);
      return { text: `${i.coin} leverage is now ${i.leverage}x (cross)` };
    }
    case 'aave_supply': {
      const amount = parseUnits(i.amount, 6);
      const a = await ensureAllowance(u, USDC, AAVE_POOL, amount, progress);
      progress?.({ text: 'Supplying…' });
      const t = await sendEvm(u, { to: AAVE_POOL, data: encodeFunctionData({ abi: pool, functionName: 'supply', args: [USDC, amount, u.evm, 0] }) }, progress);
      return { text: `Supplied ${i.amount} USDC to Aave`, links: [a && { label: 'Approve', url: a.url }, { label: 'Supply', url: t.url }].filter(Boolean) };
    }
    case 'aave_withdraw': {
      const amount = i.amount === 'all' ? 2n ** 256n - 1n : parseUnits(i.amount, 6);
      const t = await sendEvm(u, { to: AAVE_POOL, data: encodeFunctionData({ abi: pool, functionName: 'withdraw', args: [USDC, amount, u.evm] }) }, progress);
      return { text: i.amount === 'all' ? 'Withdrew all USDC from Aave' : `Withdrew ${i.amount} USDC from Aave`, links: [{ label: 'Withdraw', url: t.url }] };
    }
    case 'swap': {
      const [tokenIn, tokenOut, dIn, dOut] = i.from === 'USDC' ? [USDC, WETH, 6, 18] : [WETH, USDC, 18, 6];
      if (!['USDC', 'ETH'].includes(i.from) || !['USDC', 'ETH'].includes(i.to)) throw new Refused('swaps are USDC ↔ ETH on Base Sepolia');
      const amountIn = parseUnits(i.amount, dIn);
      const links = [];
      if (tokenIn === WETH) {
        // Wrap only the ETH that isn't already WETH.
        const have = await evm.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [u.evm] });
        if (have < amountIn) {
          progress?.({ text: 'Wrapping ETH…' });
          const w = await sendEvm(u, { to: WETH, data: encodeFunctionData({ abi: weth, functionName: 'deposit' }), value: amountIn - have }, progress);
          links.push({ label: 'Wrap', url: w.url });
        }
      }
      const { result } = await evm.simulateContract({ address: QUOTER, abi: uni, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee: FEE, sqrtPriceLimitX96: 0n }] });
      const minOut = (result[0] * 98n) / 100n; // 2% slippage
      const a = await ensureAllowance(u, tokenIn, ROUTER, amountIn, progress);
      if (a) links.push({ label: 'Approve', url: a.url });
      progress?.({ text: 'Swapping…' });
      const before = tokenOut === WETH ? await evm.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [u.evm] }) : 0n;
      const t = await sendEvm(u, { to: ROUTER, data: encodeFunctionData({ abi: uni, functionName: 'exactInputSingle', args: [{ tokenIn, tokenOut, fee: FEE, recipient: u.evm, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] }) }, progress);
      links.push({ label: 'Swap', url: t.url });
      if (tokenOut === WETH) {
        // Uniswap pays WETH: unwrap what this swap paid, so the wallet holds plain ETH.
        // Grants approved before unwrapping existed don't list it: then the WETH stays.
        const got = (await evm.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [u.evm] })) - before;
        if (got > 0n && (await canUnwrap(u))) {
          progress?.({ text: 'Unwrapping to ETH…' });
          const w = await sendEvm(u, { to: WETH, data: encodeFunctionData({ abi: weth, functionName: 'withdraw', args: [got] }) }, progress);
          links.push({ label: 'Unwrap', url: w.url });
        } else if (got > 0n) {
          return { text: `Swapped ${i.amount} ${i.from} for ${Number(formatUnits(got, 18)).toPrecision(4)} WETH (wrapped ETH). Reconnect with /link to let the bot unwrap it.`, links };
        }
      }
      const got = Number(formatUnits(result[0], dOut));
      return { text: `Swapped ${i.amount} ${i.from} for about ${got.toPrecision(4)} ${i.to}`, links };
    }
    default:
      throw new Refused(`can't do "${i.kind}"`);
  }
}

/** Whether the user's grant lets the bot unwrap WETH (grants from before this step don't). */
async function canUnwrap(u) {
  const g = (await agentFor(u).session())?.grant;
  const s = sel('function withdraw(uint256)');
  return !!g?.evm_venues?.some((v) => v.chain_id === CHAIN_ID && v.to.toLowerCase() === WETH && v.selector.toLowerCase() === s);
}

/** A short random id for a confirm prompt. */
export const promptId = () => crypto.randomBytes(6).toString('base64url');
