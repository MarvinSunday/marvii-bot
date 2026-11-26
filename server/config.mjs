// Settings, all from the environment. Secrets (the bot token, the OutLayer
// operator key) are read here and never logged.

const env = (k, d) => process.env[k] ?? d;

export const config = {
  /** Telegram bot token from @BotFather. Without it the bot side stays off. */
  telegramToken: env('TELEGRAM_BOT_TOKEN'),
  /** Where this server is reachable from outside (permission-link return, glasses app). */
  publicUrl: env('PUBLIC_URL', 'http://localhost:8790').replace(/\/$/, ''),
  port: Number(env('PORT', 8790)),
  /** JSON file holding linked users and pairings. */
  dataFile: env('DATA_FILE', '.data/store.json'),

  marvii: {
    page: env('MARVII_PAGE', 'https://near.marvii.xyz'),
    relayer: env('MARVII_RELAYER', 'https://relayer.marvii.xyz'),
  },

  /**
   * The agent's key lives in Marvii's OutLayer module (Intel TDX); the bot
   * never sees it. Each signature is an OutLayer run paid by this NEAR
   * testnet account.
   */
  outlayer: {
    operator: env('OUTLAYER_OPERATOR'),
    operatorKey: env('OUTLAYER_OPERATOR_KEY'),
    moduleHash: env('OUTLAYER_MODULE_HASH'),
    moduleUrl: env('OUTLAYER_MODULE_URL'),
  },

  /** A local session key instead, for tests against your own page and extension only. */
  localSeed: env('LOCAL_AGENT_SEED'),

  evmRpc: env('BASE_SEPOLIA_RPC', 'https://sepolia.base.org'),
  hyperliquid: env('HL_API', 'https://api.hyperliquid-testnet.xyz'),
  polymarket: env('POLYMARKET_API', 'https://gamma-api.polymarket.com'),

  /** How often to refresh positions and check alerts. */
  pollMs: Number(env('POLL_MS', 20_000)),
  /** Whisper model for speech-to-text, run locally. */
  whisperModel: env('WHISPER_MODEL', 'onnx-community/whisper-base.en'),
};
