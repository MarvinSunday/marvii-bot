// The HTTP side: the glasses app's API, the permission link's return page,
// and the glasses app itself (glasses/dist).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { newPairing, deviceUser, byKeyId, update, pair, user } from './store.mjs';
import { ask, confirm, lines, openPrompt, promptText, currentActivity } from './core.mjs';
import { verifyLink, linkFor } from './marvii.mjs';
import { transcribe } from './stt.mjs';

export const linkedHooks = { linked: async (_u) => {} };

const MAX_AUDIO = 16000 * 2 * 15; // 15 s of 16 kHz 16-bit mono
const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../glasses/dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type,
    // The glasses app runs in the Even app's WebView, on another origin.
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  if (status === 204) return res.end();
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function body(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = async (req) => JSON.parse((await body(req, 10_000)).toString() || '{}');
const device = (req) => deviceUser((req.headers.authorization ?? '').replace(/^Bearer /, ''));

/** What the glasses show now. */
async function state(u) {
  if (!u) return { paired: false };
  const id = openPrompt(u);
  return {
    paired: true,
    linked: !!u.wallet,
    lines: u.wallet ? await lines(u).catch(() => ['Data unavailable']) : [],
    prompt: id ? { id, text: promptText(id) } : null,
    activity: currentActivity(u),
  };
}

const page = (title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0B0D12;color:#ECECF2;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:420px;text-align:center}a{color:#8C84F7}</style>
<main><h1>${title}</h1><p>${text}</p></main>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function startHttp() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (url.pathname === '/health') return send(res, 200, { ok: true });

      // ---- Glasses API
      if (url.pathname === '/g/pair' && req.method === 'POST') return send(res, 200, newPairing());
      if (url.pathname === '/g/state') return send(res, 200, await state(device(req)));
      if (url.pathname === '/g/say' && req.method === 'POST') {
        const u = device(req);
        if (!u) return send(res, 401, { error: 'not paired' });
        const { text } = await json(req);
        return send(res, 200, { heard: text, ...(await ask(u, String(text ?? '').slice(0, 200))) });
      }
      if (url.pathname === '/g/voice' && req.method === 'POST') {
        const u = device(req);
        if (!u) return send(res, 401, { error: 'not paired' });
        const heard = await transcribe(await body(req, MAX_AUDIO));
        if (!heard) return send(res, 200, { heard: '', kind: 'unknown', text: "Didn't hear anything." });
        return send(res, 200, { heard, ...(await ask(u, heard)) });
      }
      if (url.pathname === '/g/confirm' && req.method === 'POST') {
        const u = device(req);
        if (!u) return send(res, 401, { error: 'not paired' });
        const { id, yes } = await json(req);
        // Only the prompt that's open for this user.
        if (openPrompt(u) !== id) return send(res, 409, { error: 'no such prompt' });
        return send(res, 200, { ok: confirm(id, !!yes) });
      }

      // ---- Local testing only (DEV_ROUTES=1): pair and link without Telegram or a passkey.
      if (process.env.DEV_ROUTES === '1' && url.pathname === '/dev/link' && req.method === 'POST') {
        const { code, tgId, wallet, evm } = await json(req);
        const ok = pair(String(code), tgId);
        update(tgId, { wallet, evm });
        return send(res, 200, { ok });
      }

      if (process.env.DEV_ROUTES === '1' && url.pathname === '/dev/permission-link') {
        const u = user(url.searchParams.get('tg'));
        return send(res, 200, { keyId: u.keyId, link: await linkFor(u, `${config.publicUrl}/linked`) });
      }

      // ---- The wallet page sends the owner back here after the passkey approved the grant.
      if (url.pathname === '/linked') {
        const keyId = url.searchParams.get('key_id'), wallet = url.searchParams.get('wallet');
        const u = keyId && byKeyId(keyId);
        if (!u || !wallet) return send(res, 400, page('Link not recognised', 'Start again from Telegram with /start.'), 'text/html; charset=utf-8');
        // Believe nothing in the URL: read the grant on NEAR.
        const v = await verifyLink(u, wallet);
        if (!v) return send(res, 400, page('Not approved yet', 'The wallet has no grant for Marvii bot. Try the link again from Telegram.'), 'text/html; charset=utf-8');
        update(u.id, { wallet, evm: v.evm, expiresAt: v.expiresAt });
        linkedHooks.linked(u).catch(() => {});
        return send(res, 200, page('Marvii bot is linked', `Wallet <b>${esc(wallet)}</b> is connected. You can close this page and go back to Telegram.`), 'text/html; charset=utf-8');
      }

      // ---- The glasses app (built with Vite into glasses/dist)
      if (req.method === 'GET') {
        const f = path.join(DIST, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
        if (f.startsWith(DIST) && fs.existsSync(f) && fs.statSync(f).isFile()) return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] ?? 'application/octet-stream');
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error(`${req.method} ${url.pathname}: ${e.message}`);
      send(res, 500, { error: 'server error' });
    }
  });
  server.listen(config.port, () => console.log(`http on :${config.port} (${config.publicUrl})`));
  return server;
}
