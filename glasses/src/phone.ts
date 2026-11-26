// The phone side of the same page (inside the Even app, or any browser):
// a mirror of the glasses, the pairing code, and a box to type a command.
import type { State } from './api';

let el: Record<string, HTMLElement> = {};

export const phone = {
  mount({ api, command }: { api: string; command: (t: string) => Promise<void> }) {
    document.body.innerHTML = `
      <main>
        <header><b>Marvii</b><span class="mute">for G2</span></header>
        <section class="glass" aria-label="What the glasses show">
          <div id="g-title" class="g-title"></div>
          <div id="g-body" class="g-body"></div>
          <div id="g-hint" class="g-hint"></div>
        </section>
        <p id="code" class="note" hidden></p>
        <form id="say"><input id="text" placeholder='Type a command, e.g. "buy 0.01 eth"' autocomplete="off"><button>Send</button></form>
        <p class="note"><button id="help" type="button" class="link">What can I say?</button></p>
        <p class="note mute">Hold the touchpad (or the R1 ring) to speak. Actions stay within the limits you approved with your passkey on near.marvii.xyz.</p>
        <p class="note mute small">Server: ${api.replace(/[<>&"]/g, '')}</p>
      </main>`;
    el = Object.fromEntries(['g-title', 'g-body', 'g-hint', 'code', 'say', 'text', 'help'].map((id) => [id, document.getElementById(id)!]));
    el.help.addEventListener('click', () => void command('help'));
    el.say.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = el.text as HTMLInputElement;
      const t = input.value.trim();
      if (t) void command(t).then(() => (input.value = ''));
    });
  },
  view(v: { title: string; hint: string } & ({ kind: 'text'; body: string } | { kind: 'list'; items: string[] })) {
    if (!el['g-title']) return;
    el['g-title'].textContent = v.title;
    el['g-hint'].textContent = v.hint;
    el['g-body'].innerHTML = '';
    if (v.kind === 'text') el['g-body'].textContent = v.body;
    else for (const i of v.items) { const d = document.createElement('div'); d.className = 'g-item'; d.textContent = i; el['g-body'].append(d); }
  },
  code(c: string) {
    el.code.hidden = false;
    el.code.innerHTML = `Pair these glasses: send <code>/pair ${c}</code> to Marvii bot in Telegram.`;
  },
  state(s: State | null) {
    if (s?.paired) el.code.hidden = true;
  },
};
