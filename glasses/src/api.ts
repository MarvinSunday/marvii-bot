// The Marvii bot server. Served by it: same origin. Packed (.ehpk): VITE_API.
const fromPage = location.protocol.startsWith('http') && !import.meta.env.DEV ? location.origin : '';
export const API = (import.meta.env.VITE_API as string | undefined) ?? (fromPage || 'http://localhost:8790');

export type Activity = { text: string; waiting?: boolean; url?: string; done?: boolean; ok?: boolean; links?: { label: string; url: string }[]; at: number };
export type State =
  | { paired: false }
  | { paired: true; linked: boolean; lines: string[]; prompt: { id: string; text: string } | null; activity: Activity | null };
export type Reply = { heard?: string; kind: 'prompt' | 'status' | 'help' | 'handoff' | 'confirmed' | 'cancelled' | 'unknown'; id?: string; text?: string; lines?: string[]; error?: string; reason?: string };

let token = '';
export const setToken = (t: string) => (token = t);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(API + path, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok && r.status !== 409) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

export const pairStart = () => call<{ token: string; code: string }>('/g/pair', { method: 'POST' });
export const getState = () => call<State>('/g/state');
export const say = (text: string) => call<Reply>('/g/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
export const voice = (pcm: Uint8Array) => call<Reply>('/g/voice', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm as BodyInit });
export const answer = (id: string, yes: boolean) => call<{ ok: boolean }>('/g/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, yes }) });
