// Read-only data: Hyperliquid testnet positions, Aave on Base Sepolia,
// Polymarket odds. Nothing here signs or spends.
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';
import { config } from './config.mjs';

// Aave V3 on Base Sepolia (bgd-labs/aave-address-book, AaveV3BaseSepolia.sol),
// checked on-chain in near/agent/agent.mjs: the pool lists this USDC.
export const AAVE_POOL = '0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27';
export const USDC = '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f';
// aUSDC: read from the pool (getReserveData) on first use, not hard-coded.
export const WETH = '0x4200000000000000000000000000000000000006';

export const evm = createPublicClient({ chain: baseSepolia, transport: http(config.evmRpc) });
export const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
export const pool = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);

// ---- Hyperliquid (testnet)

async function hlInfo(body) {
  const r = await fetch(`${config.hyperliquid}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Hyperliquid ${r.status}`);
  return r.json();
}

let meta = null;
/** Markets by name: `{ ETH: { asset, szDecimals, maxLeverage } }` (asset = index in `meta`). */
export async function hlMarkets() {
  if (!meta) {
    const m = await hlInfo({ type: 'meta' });
    meta = Object.fromEntries(m.universe.map((u, asset) => [u.name, { asset, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage }]));
  }
  return meta;
}

export const hlMids = () => hlInfo({ type: 'allMids' });

/** Open perps positions and account value for an address. */
export async function hlState(address) {
  const s = await hlInfo({ type: 'clearinghouseState', user: address });
  const mids = await hlMids();
  const positions = s.assetPositions.map(({ position: p }) => {
    const size = Number(p.szi), mark = Number(mids[p.coin] ?? p.entryPx), liq = p.liquidationPx ? Number(p.liquidationPx) : null;
    return {
      coin: p.coin, size, side: size > 0 ? 'long' : 'short', entry: Number(p.entryPx), mark,
      pnl: Number(p.unrealizedPnl), roe: Number(p.returnOnEquity) * 100,
      liq, liqDistancePct: liq ? Math.abs(mark - liq) / mark * 100 : null,
      leverage: p.leverage?.value,
    };
  });
  return { accountValue: Number(s.marginSummary.accountValue), withdrawable: Number(s.withdrawable), positions };
}

// ---- Aave (Base Sepolia)

let aUsdc = null;
export async function aaveState(address) {
  aUsdc ??= (await evm.readContract({ address: AAVE_POOL, abi: pool, functionName: 'getReserveData', args: [USDC] })).aTokenAddress;
  const [acct, cash, supplied] = await Promise.all([
    evm.readContract({ address: AAVE_POOL, abi: pool, functionName: 'getUserAccountData', args: [address] }),
    evm.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [address] }),
    evm.readContract({ address: aUsdc, abi: erc20, functionName: 'balanceOf', args: [address] }),
  ]);
  const debt = Number(formatUnits(acct[1], 8));
  return {
    collateralUsd: Number(formatUnits(acct[0], 8)),
    debtUsd: debt,
    // Aave reports max uint for "no debt"; show that as no health number.
    health: debt >= 0.01 ? Number(formatUnits(acct[5], 18)) : null,
    usdc: Number(formatUnits(cash, 6)),
    suppliedUsdc: Number(formatUnits(supplied, 6)),
  };
}

export async function ethBalance(address) {
  const [eth, weth] = await Promise.all([
    evm.getBalance({ address }),
    evm.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [address] }),
  ]);
  return { eth: Number(formatUnits(eth, 18)), weth: Number(formatUnits(weth, 18)) };
}

// ---- Polymarket (read only: Polymarket runs on mainnet only)

/** A market's question and odds by its slug (the last part of its polymarket.com URL). */
export async function polymarket(slug) {
  const r = await fetch(`${config.polymarket}/markets?slug=${encodeURIComponent(slug)}`);
  const [m] = await r.json();
  if (!m) return null;
  const outcomes = JSON.parse(m.outcomes), prices = JSON.parse(m.outcomePrices).map(Number);
  return { slug, question: m.question, outcomes: outcomes.map((name, i) => ({ name, price: prices[i], pct: Math.round(prices[i] * 1000) / 10 })), closed: m.closed };
}

/**
 * The open markets of an event, by the event's slug. An event link
 * (polymarket.com/event/...) usually names an event, which can hold several
 * markets (one per deadline or candidate).
 */
export async function polymarketEvent(slug) {
  const r = await fetch(`${config.polymarket}/events?slug=${encodeURIComponent(slug)}`);
  const [e] = await r.json();
  if (!e) return null;
  return { title: e.title, markets: (e.markets ?? []).filter((m) => !m.closed).map((m) => ({ slug: m.slug, question: m.question })) };
}

/** Accepts a slug or a polymarket.com URL. */
export const polymarketSlug = (s) => String(s).trim().replace(/^https?:\/\/(www\.)?polymarket\.com\/(event|market)\//, '').replace(/[/?#].*$/, '');

// ---- Everything for one user

export async function snapshot(u) {
  const out = { at: Date.now(), hl: null, aave: null, eth: null, markets: [], errors: [] };
  const jobs = [];
  if (u.evm) {
    jobs.push(hlState(u.evm).then((x) => (out.hl = x), (e) => out.errors.push(`Hyperliquid: ${e.message}`)));
    jobs.push(aaveState(u.evm).then((x) => (out.aave = x), (e) => out.errors.push(`Aave: ${e.message}`)));
    jobs.push(ethBalance(u.evm).then((x) => (out.eth = x), (e) => out.errors.push(`Base: ${e.message}`)));
  }
  // Followed markets, and any market holding a paper bet.
  for (const slug of new Set([...(u.watch ?? []), ...(u.bets ?? []).map((b) => b.slug)])) jobs.push(polymarket(slug).then((x) => x && out.markets.push(x), () => {}));
  await Promise.all(jobs);
  return out;
}

const usd = (n) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`);
const signed = (n, f = (x) => x) => (n >= 0 ? '+' : '-') + f(Math.abs(n));

/**
 * The glance: one short line per thing that matters, most urgent first.
 * Each line fits the glasses (about 32 characters).
 */
export function glance(s) {
  const lines = [];
  for (const p of s.hl?.positions ?? []) {
    lines.push({ urgent: p.liqDistancePct !== null && p.liqDistancePct < 10, text: `${p.coin} ${p.side} ${signed(p.pnl, usd)} ${signed(p.roe, (x) => x.toFixed(1))}%` });
  }
  if (s.hl && !s.hl.positions.length) lines.push({ text: `Hyperliquid ${usd(s.hl.accountValue)}, no position` });
  if (s.aave) {
    const a = s.aave;
    if (a.health !== null) lines.push({ urgent: a.health < 1.3, text: `Aave health ${a.health.toFixed(2)}` });
    lines.push({ text: `Aave ${usd(a.suppliedUsdc)} in, ${usd(a.usdc)} cash` });
  }
  if (s.eth) {
    const eth = s.eth.eth + s.eth.weth;
    lines.push({ text: `Base ${eth.toFixed(4)} ETH${s.eth.weth > 0.00005 ? ` (${s.eth.weth.toFixed(4)} wrapped)` : ''}` });
  }
  for (const m of s.markets) {
    const top = [...m.outcomes].sort((a, b) => b.pct - a.pct)[0];
    lines.push({ text: `${m.question.slice(0, 20).trim()}… ${top.name.slice(0, 6)} ${top.pct}%` });
  }
  for (const b of s.bets ?? []) {
    lines.push({ text: `Paper ${b.outcome.slice(0, 6)} ${b.question.slice(0, 12).trim()}… ${signed(b.pnl, usd)}${b.closed ? ' (settled)' : ''}` });
  }
  return lines.sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent)).map((l) => (l.urgent ? '! ' : '') + l.text);
}
