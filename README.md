# Marvii bot

Your trading positions at a glance on Even Realities G2, and in Telegram. Say "close my ETH" and tap to confirm. The bot acts through a [Marvii](https://near.marvii.xyz) wallet, so it can only do what your passkey allowed: listed markets, daily limits, nothing sent to anyone else.

Built for **Heads Up** (Even Realities × TVM Ventures × Daos Hub).
- **Main track:** 02, Crypto & DeFi (Hyperliquid, Polymarket).
- **Second track:** 01, Messaging (Telegram), plus the Telegram prize.

## The problem

During a trading session you check the same few numbers again and again: PnL, distance to liquidation, a health factor, the odds on a market. Acting means unlocking the phone, opening an app and signing.

Bots that do it for you need your keys, and a bot holding your keys can do anything with them.

## What it does

**Read: one glance**
- Hyperliquid testnet positions: side, PnL and return, most urgent first.
- Aave on Base Sepolia: what you supplied, cash, and the health factor when you borrow.
- Polymarket odds on markets you follow (read only, see Limits).
- Alerts in Telegram, sent once per crossing: near liquidation, PnL moving in 5% steps, Aave health under 1.3, odds moving.

**Write: a short phrase, then one tap**

Hold the touchpad or the R1 ring and speak, send a Telegram voice note, or type:

| Say | Does |
|---|---|
| `buy 0.01 eth` · `short 0.02 btc` | Hyperliquid testnet perp, a marketable limit order at most 1% from the mid price |
| `close eth` | closes the open position (reduce-only) |
| `supply 50 usdc` · `withdraw 20 usdc` · `withdraw all` | Aave V3 on Base Sepolia |
| `swap 10 usdc to eth` · `swap 0.001 eth for usdc` | Uniswap V3 on Base Sepolia |
| `status` | the glance, now |

- **The glasses** show `Buy 0.01 ETH perp?` with Confirm and Cancel. Tap to confirm; double-tap cancels.
- **Telegram** shows the same prompt with buttons.
- **The result** comes back on both, with explorer links in Telegram.

## How it stays safe

```
glasses / Telegram ──phrase──▶ Marvii bot ──confirm tap──▶ signs a request with its session key
                                                            (inside Marvii's OutLayer TEE module)
     ▼
Marvii extension on NEAR: is this market or contract in the grant? within today's limit?
does the result go back to the wallet itself?  ── no ──▶ refused
     │ yes                       over a limit ──▶ waits for the owner's passkey on the phone
     ▼
NEAR Chain Signatures sign for the wallet's address ──▶ Hyperliquid / Base Sepolia
```

- **The bot holds no wallet keys.** Its session key is made and kept inside Marvii's module on OutLayer (Intel TDX). The bot asks the enclave to sign, and never sees the key.
- **The owner sets the limits once,** with a passkey (Face ID or fingerprint) on near.marvii.xyz. The link from `/start` shows exactly what the bot asks for:
  - Hyperliquid ETH and BTC perps up to 3x and $2,000 of orders a day
  - Aave supply and withdraw, Uniswap USDC↔ETH, wrapping ETH
  - up to 500 USDC and 0.2 ETH a day
  - 30 days, or 14 days unused
- **Every request is checked on-chain** by Marvii's extension contract before anything is signed:
  - the market and contract, and the daily limits
  - that Aave and Uniswap results go to the wallet's own address
  - a request outside the grant is refused, whatever the bot or a hacked server sends
- **Over a limit**, an EVM request waits for the owner's passkey: the glasses say "Approve on your phone" and Telegram sends the link.
- **Revoke at any time** in Apps & agents on near.marvii.xyz. `/unlink` also forgets the wallet here.
- **The bot checks every signature** recovers to the wallet's own address before broadcasting.
- **Voice stays on our server.** Speech-to-text is Whisper running on our own server (transformers.js), not a third-party API.

## Run it

Requirements: Node 20.17+, ffmpeg (for Telegram voice notes).

```bash
npm install
cp .env.example .env   # then fill it in (see below)
cd glasses && npm install && npm run build && cd ..
node --env-file=.env server/index.mjs
```

**Settings** (`.env.example`):
- `TELEGRAM_BOT_TOKEN`: from @BotFather.
- `PUBLIC_URL`: where the server is reachable over https. The wallet page sends the owner back to `PUBLIC_URL/linked`, and the server serves the glasses app at `/`.
- `OUTLAYER_OPERATOR`, `OUTLAYER_OPERATOR_KEY`: a NEAR testnet account that pays for the OutLayer runs (one per signature). The agent's key is derived inside the enclave for that operator and Marvii's published module.

**Glasses in the simulator:**

```bash
npm i -g @evenrealities/evenhub-simulator
evenhub-simulator http://localhost:8790/
```

Hold or long-press to speak. The page also has a box to type a command, handy without a microphone.

**Glasses on G2:** run `npx evenhub qr --url <PUBLIC_URL>` and scan it in the Even app's developer mode. Or pack it with `cd glasses && VITE_API=<PUBLIC_URL> npm run pack`, and put that URL in `app.json`'s network whitelist.

**Deploy:** the `Dockerfile` builds both parts. On Railway, mount a volume at `/data`, which keeps the user store and the speech model.

**Tests:** `npm test` (the phrase grammar).

## Using it

1. In Telegram, send `/start` to the bot and tap **Connect Marvii wallet**. The page opens in the browser, since passkeys don't work inside Telegram. Approve with your passkey, and the page returns you to the bot.
2. Open Marvii on the glasses. It shows a 6-digit code: send `/pair 123456` to the bot.
3. Optional: `/watch <polymarket link>` to follow a market's odds.

## Limits and honest notes

- **Testnets only**, per the hackathon rules:
  - Hyperliquid testnet
  - Base Sepolia for Aave and Uniswap
  - NEAR testnet for the Marvii wallet and extension
- **Polymarket is read only.** It runs on mainnet only. Marvii's extension can check Polymarket orders, which was tested on a mainnet fork, but this demo doesn't place them.
- **Over-limit approval by passkey** works for EVM requests (Aave, Uniswap). A Hyperliquid order over its daily limit is refused.
- **One server process** holds users in a JSON file, which is enough for the demo.

## What existed before 23 November 2026

Built before the hackathon, by the same team, and used here as a dependency:
- **Marvii's wallet, policy extension contract, relayer and OutLayer TEE module,** at [replico-labs/marvii-near](https://github.com/replico-labs/marvii-near).
- **The Marvii SDK,** at `server/vendor/marvii-sdk.mjs`, copied unchanged from that repo because it isn't on npm yet.

The Hyperliquid and EVM signing steps here follow its demo agent (`near/agent/agent.mjs`).

Built during the hackathon: everything else in this repo.
- the Telegram bot
- the glasses app
- the phrase grammar
- speech-to-text
- the feeds and alerts
- pairing
- the confirm flow across both screens

## Feature requests

1. **G2 SDK:** a way to keep a small status line, or one alert, on the display while another app is open. Liquidation warnings can't wait until the user opens the app.
2. **G2 SDK:** list updates without rebuilding the page, to change one line's text in place.
3. **G2 SDK:** line breaks in text containers (the simulator drops `\n`).
4. **Hyperliquid:** a testnet faucet that doesn't need a mainnet account, so new users can try trading agents.
5. **Telegram:** passkeys (WebAuthn) inside Mini Apps, so approvals don't need to leave Telegram.

## License

MIT
