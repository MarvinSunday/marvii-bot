// The Telegram side (grammY): link a Marvii wallet, pair the glasses,
// updates and alerts, and actions by text or voice note with a confirm tap.
import { execFile } from 'node:child_process';
import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.mjs';
import { user, update, pair, unpairAll } from './store.mjs';
import { ask, confirm, lines, hooks, openPrompt } from './core.mjs';
import { linkFor } from './marvii.mjs';
import { polymarket, polymarketSlug } from './feeds.mjs';
import { transcribe } from './stt.mjs';
import { linkedHooks } from './http.mjs';

const HELP = [
  'Say or type what you want, then tap Confirm:',
  '• buy 0.01 eth · short 0.02 eth · close eth  (Hyperliquid testnet)',
  '• supply 50 usdc · withdraw 20 usdc  (Aave, Base Sepolia)',
  '• swap 10 usdc to eth  (Uniswap, Base Sepolia)',
  '• status',
  '',
  '/watch <polymarket link>: follow a market\'s odds',
  '/pair <code>: connect your G2 glasses',
  '/unlink: forget your wallet here',
].join('\n');

const keyboard = (links = []) => {
  const k = new InlineKeyboard();
  for (const l of links) k.url(l.label, l.url).row();
  return links.length ? k : undefined;
};

/** OGG/Opus voice note → 16 kHz s16le PCM, with ffmpeg. */
function oggToPcm(buf) {
  return new Promise((resolve, reject) => {
    const p = execFile('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16000 * 2 * 60 }, (err, out) => (err ? reject(err) : resolve(out)));
    p.stdin.end(buf);
  });
}

export function startBot() {
  if (!config.telegramToken) {
    console.log('TELEGRAM_BOT_TOKEN not set: Telegram is off');
    return null;
  }
  const bot = new Bot(config.telegramToken);

  // Direct messages only: the bot talks about one person's money.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return;
    return next();
  });

  hooks.notify = async (u, m) => {
    const links = [...(m.links ?? []), ...(m.url ? [{ label: m.button ?? 'Open', url: m.url }] : [])];
    await bot.api.sendMessage(u.id, m.text, { reply_markup: keyboard(links), link_preview_options: { is_disabled: true } }).catch((e) => console.error(`notify: ${e.message}`));
  };
  linkedHooks.linked = async (u) => {
    await bot.api.sendMessage(u.id, `✅ Linked to ${u.wallet}.\n\n${HELP}`);
    const l = await lines(u, { fresh: true }).catch(() => []);
    if (l.length) await bot.api.sendMessage(u.id, l.join('\n'));
  };

  async function sendLink(ctx, u) {
    const link = await linkFor(u, `${config.publicUrl}/linked`);
    await ctx.reply(
      'Marvii bot follows your positions and acts for you, but only within limits you set with your passkey:\n' +
      '• Hyperliquid testnet: ETH and BTC perps, up to 3x, $2,000 of orders a day\n' +
      '• Aave and Uniswap on Base Sepolia: up to 500 USDC and 0.2 ETH a day\n' +
      '• Nothing can be sent to anyone else. Over a limit, your phone asks for your passkey.\n\n' +
      'Open the link, check what it asks for, and approve with Face ID or your fingerprint. It opens in your browser, since passkeys don\'t work inside Telegram.',
      { reply_markup: new InlineKeyboard().url('Connect Marvii wallet', link) },
    );
  }

  bot.command('start', async (ctx) => {
    const u = user(ctx.from.id);
    if (u.wallet) {
      await ctx.reply(`Linked to ${u.wallet}.\n\n${HELP}`);
      return;
    }
    await sendLink(ctx, u);
  });
  bot.command('help', (ctx) => ctx.reply(HELP));
  bot.command('link', async (ctx) => sendLink(ctx, user(ctx.from.id)));
  bot.command('unlink', async (ctx) => {
    update(ctx.from.id, { wallet: null, evm: null });
    unpairAll(ctx.from.id);
    await ctx.reply('Forgotten here, and your glasses are unpaired. To cut the bot off on-chain too, revoke "Marvii bot" in Apps & agents on near.marvii.xyz.');
  });
  bot.command('status', async (ctx) => {
    const u = user(ctx.from.id);
    if (!u.wallet) return sendLink(ctx, u);
    const l = await lines(u, { fresh: true });
    await ctx.reply(l.length ? l.join('\n') : 'Nothing to show yet.');
  });
  bot.command('pair', async (ctx) => {
    const code = (ctx.match ?? '').replace(/\D/g, '');
    if (code.length !== 6) return ctx.reply('Open Marvii on your G2 glasses: it shows a 6-digit code. Then send /pair 123456');
    await ctx.reply(pair(code, ctx.from.id) ? '🕶 Glasses paired.' : 'That code is wrong or expired. Open Marvii on the glasses for a new one.');
  });
  bot.command('watch', async (ctx) => {
    const u = user(ctx.from.id);
    const slug = polymarketSlug(ctx.match ?? '');
    if (!slug) return ctx.reply(u.watch.length ? `Watching:\n${u.watch.join('\n')}\n\n/unwatch <slug> to stop.` : 'Send /watch with a Polymarket market link.');
    const m = await polymarket(slug).catch(() => null);
    if (!m) return ctx.reply('No Polymarket market with that link. Use a market page (polymarket.com/event/…).');
    update(u.id, { watch: [...new Set([...u.watch, slug])].slice(-5) });
    await ctx.reply(`👀 ${m.question}\n${m.outcomes.map((o) => `${o.name} ${o.pct}%`).join(' · ')}\n\nYou'll hear when the odds move. (Read only: Polymarket runs on mainnet, and this demo stays on testnets.)`);
  });
  bot.command('unwatch', async (ctx) => {
    const u = user(ctx.from.id);
    const slug = polymarketSlug(ctx.match ?? '');
    update(u.id, { watch: u.watch.filter((s) => s !== slug) });
    await ctx.reply('Stopped watching it.');
  });

  async function handlePhrase(ctx, text) {
    const u = user(ctx.from.id);
    const r = await ask(u, text);
    if (r.kind === 'prompt') {
      await ctx.reply(r.text, { reply_markup: new InlineKeyboard().text('Confirm', `y:${r.id}`).text('Cancel', `n:${r.id}`) });
    } else if (r.kind === 'status') {
      await ctx.reply(r.lines.length ? r.lines.join('\n') : 'Nothing to show yet.');
    } else if (r.kind === 'cancelled') {
      await ctx.reply('Cancelled.');
    } else if (r.kind !== 'confirmed') {
      await ctx.reply(r.text);
    }
  }

  bot.on('message:text', (ctx) => handlePhrase(ctx, ctx.message.text));
  bot.on('message:voice', async (ctx) => {
    if (ctx.message.voice.duration > 15) return ctx.reply('Keep it under 15 seconds, like "buy 0.01 eth".');
    const file = await ctx.getFile();
    const ogg = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`)).arrayBuffer());
    const heard = await transcribe(await oggToPcm(ogg));
    if (!heard) return ctx.reply("Didn't hear anything.");
    await ctx.reply(`🎙 "${heard}"`);
    await handlePhrase(ctx, heard);
  });

  bot.callbackQuery(/^(y|n):(.+)$/, async (ctx) => {
    const [, yn, id] = ctx.match;
    // Only the prompt open for this user.
    const ok = openPrompt(user(ctx.from.id)) === id && confirm(id, yn === 'y');
    await ctx.answerCallbackQuery(ok ? (yn === 'y' ? 'Confirmed' : 'Cancelled') : 'This request expired');
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.catch((e) => console.error(`bot: ${e.error?.message ?? e.message}`));
  bot.api.setMyCommands([
    { command: 'status', description: 'Your positions at a glance' },
    { command: 'watch', description: 'Follow a Polymarket market' },
    { command: 'pair', description: 'Connect your G2 glasses' },
    { command: 'link', description: 'Connect your Marvii wallet' },
    { command: 'help', description: 'What Marvii bot can do' },
  ]).catch(() => {});
  bot.start({ onStart: (me) => console.log(`Telegram: @${me.username}`) });
  return bot;
}
