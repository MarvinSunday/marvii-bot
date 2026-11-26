// Marvii on G2: one glance at your positions; hold to speak a command; tap
// to confirm. Everything runs within the limits your passkey gave Marvii bot.
import {
  waitForEvenAppBridge, AudioInputSource, OsEventTypeList, StartUpPageCreateResult,
  CreateStartUpPageContainer, RebuildPageContainer, TextContainerProperty, TextContainerUpgrade,
  ListContainerProperty, ListItemContainerProperty,
  type EvenAppBridge, type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import { API, setToken, pairStart, getState, say, voice, answer, type State, type Reply } from './api';
import { phone } from './phone';

// ---------------------------------------------------------------- view ----

/** What the glasses show: a title, a body (text) or a list, and a hint line. */
type View =
  | { kind: 'text'; title: string; body: string; hint: string }
  | { kind: 'list'; title: string; items: string[]; hint: string; name: 'home' | 'prompt' };

const W = 576, H = 288;

/** The glasses' font is plain: keep to ASCII-ish text. */
const plain = (s: string) => s.replace(/…/g, '...').replace(/[·•]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E]/g, '').trim();

let bridge: EvenAppBridge | null = null;
let shown: { kind: string; key: string } | null = null;

async function render(v: View) {
  phone.view(v);
  if (!bridge) return;
  const title = { xPosition: 8, yPosition: 4, width: W - 16, height: 36, containerID: 1, containerName: 'title', content: plain(v.title), textColor: 3, isEventCapture: 0, zOrderIndex: 1 };
  const hint = { xPosition: 8, yPosition: H - 38, width: W - 16, height: 34, containerID: 3, containerName: 'hint', content: plain(v.hint), textColor: 2, isEventCapture: 0, zOrderIndex: 3 };
  const key = v.kind === 'list' ? v.name + '|' + v.items.join('|') : 'text';
  if (shown?.kind === v.kind && shown.key === key) {
    // Same layout: update the text in place, no flicker.
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'title', content: title.content }));
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 3, containerName: 'hint', content: hint.content }));
    if (v.kind === 'text') await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: 'body', content: plain(v.body) }));
    return;
  }
  const text = (o: object) => new TextContainerProperty(o);
  const page = v.kind === 'text'
    ? { containerTotalNum: 3, textObject: [text(title), text({ xPosition: 8, yPosition: 48, width: W - 16, height: H - 96, containerID: 2, containerName: 'body', content: plain(v.body), textColor: 4, isEventCapture: 1, zOrderIndex: 2 }), text(hint)] }
    : {
        containerTotalNum: 3,
        textObject: [text(title), text(hint)],
        listObject: [new ListContainerProperty({
          xPosition: 8, yPosition: 44, width: W - 16, height: H - 88, containerID: 2, containerName: v.name,
          itemContainer: new ListItemContainerProperty({ itemCount: v.items.length, itemName: v.items.map((s) => plain(s).slice(0, 40)) }),
          isEventCapture: 1, zOrderIndex: 2,
        })],
      };
  if (!shown) {
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page));
    if (r !== StartUpPageCreateResult.success) console.warn('startup page', r);
  } else {
    await bridge.rebuildPageContainer(new RebuildPageContainer(page));
  }
  shown = { kind: v.kind, key };
}

// --------------------------------------------------------------- state ----

let state: State | null = null;
let pairCode = '';
let listening = false, thinking = false;
let flash: { text: string; lines?: string[]; until: number } | null = null;
const audio: Uint8Array[] = [];

function view(): View {
  const clock = new Date().toTimeString().slice(0, 5);
  const title = `MARVII  ${clock}`;
  if (listening) return { kind: 'text', title, body: 'Listening...', hint: 'Release when done' };
  if (thinking) return { kind: 'text', title, body: 'One moment...', hint: '' };
  if (!state || !state.paired) return { kind: 'text', title, body: pairCode ? `Send  /pair ${pairCode}  to Marvii bot in Telegram` : 'Connecting...', hint: 'Code works for 10 minutes' };
  if (!state.linked) return { kind: 'text', title, body: 'Paired. Now link your wallet: send /start to Marvii bot in Telegram.', hint: '' };
  if (flash && Date.now() < flash.until) {
    // The glasses don't break lines in text: several lines show as a list.
    return flash.lines ? { kind: 'list', name: 'home', title, items: flash.lines, hint: 'Hold to speak' } : { kind: 'text', title, body: flash.text, hint: 'Hold to speak' };
  }
  if (state.prompt) return { kind: 'list', name: 'prompt', title: state.prompt.text, items: ['Confirm', 'Cancel'], hint: 'Within your Marvii limits' };
  const a = state.activity;
  if (a && (!a.done || Date.now() - a.at < 10_000)) {
    const mark = !a.done ? (a.waiting ? '[phone] ' : '... ') : a.ok ? '[ok] ' : '[x] ';
    return { kind: 'text', title, body: mark + a.text, hint: a.waiting ? 'Approve with your passkey on your phone' : a.done ? 'Details in Telegram' : '' };
  }
  return { kind: 'list', name: 'home', title, items: state.lines.length ? state.lines : ['No positions yet'], hint: 'Hold to speak  -  tap to refresh' };
}

const show = () => render(view()).catch((e) => console.warn('render', e));

async function poll() {
  try {
    state = await getState();
  } catch (e) {
    console.warn('state', e);
  }
  phone.state(state);
  await show();
}

function handle(r: Reply) {
  if (r.kind === 'prompt') flash = null;
  else if (r.kind === 'status') flash = { text: '', lines: r.lines?.length ? r.lines : ['Nothing yet'], until: Date.now() + 8000 };
  else if (r.kind === 'unknown') flash = { text: r.reason ? r.reason : r.heard ? `Heard "${r.heard}". Try "buy 0.01 eth", "bet 10 on yes" or "status".` : (r.text ?? 'Try again'), until: Date.now() + 6000 };
  return poll();
}

export async function command(text: string) {
  thinking = true;
  await show();
  try {
    await handle(await say(text));
  } finally {
    thinking = false;
    await show();
  }
}

// --------------------------------------------------------------- input ----

async function startListening() {
  if (!bridge || listening || !state?.paired || !state.linked) return;
  audio.length = 0;
  listening = true;
  await show();
  await bridge.audioControl(true, AudioInputSource.Glasses);
}

async function stopListening() {
  if (!bridge || !listening) return;
  listening = false;
  await bridge.audioControl(false);
  const n = audio.reduce((s, c) => s + c.length, 0);
  const pcm = new Uint8Array(n);
  let o = 0;
  for (const c of audio) { pcm.set(c, o); o += c.length; }
  thinking = true;
  await show();
  try {
    await handle(await voice(pcm));
  } catch {
    flash = { text: "Couldn't reach Marvii bot", until: Date.now() + 5000 };
  } finally {
    thinking = false;
    await show();
  }
}

async function onEvent(e: EvenHubEvent) {
  if (e.audioEvent && listening) { audio.push(e.audioEvent.audioPcm); return; }
  const ev = e.listEvent ?? e.textEvent ?? e.sysEvent;
  if (!ev) return;
  const type = ev.eventType ?? OsEventTypeList.CLICK_EVENT;
  if (type === OsEventTypeList.LONG_PRESS_EVENT) return startListening();
  if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return stopListening();
  const prompt = state && state.paired ? state.prompt : null;
  if (prompt && type === OsEventTypeList.DOUBLE_CLICK_EVENT) { await answer(prompt.id, false); return poll(); }
  if (type !== OsEventTypeList.CLICK_EVENT) return;
  if (prompt && e.listEvent) {
    // List order: Confirm, Cancel.
    const yes = (e.listEvent.currentSelectItemIndex ?? 0) === 0;
    await answer(prompt.id, yes);
    return poll();
  }
  flash = null;
  return poll();
}

// ---------------------------------------------------------------- boot ----

async function storage(key: string, value?: string): Promise<string> {
  if (value !== undefined) {
    try { localStorage.setItem(key, value); } catch {}
    if (bridge) await bridge.setLocalStorage(key, value);
    return value;
  }
  const v = bridge ? await bridge.getLocalStorage(key).catch(() => '') : '';
  if (v) return v;
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

async function main() {
  phone.mount({ api: API, command });
  // Outside the Even app (a plain browser) there is no bridge: the phone view still works.
  bridge = await Promise.race([waitForEvenAppBridge(), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
  if (bridge) bridge.onEvenHubEvent((e) => void onEvent(e));
  let token = await storage('marvii-token');
  setToken(token);
  await poll();
  if (!state?.paired) {
    const p = await pairStart();
    token = await storage('marvii-token', p.token);
    setToken(token);
    pairCode = p.code;
    phone.code(p.code);
    await poll();
  }
  setInterval(poll, 3000);
}

void main();
