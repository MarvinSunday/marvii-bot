// Speech to text on our own server: a small Whisper model run with
// transformers.js (ONNX, CPU). No audio leaves the server, no API key.
import { pipeline, env } from '@huggingface/transformers';
import { config } from './config.mjs';

env.cacheDir = process.env.MODEL_CACHE ?? '.data/models';

let asr = null;
/** Loads the model once (first call downloads it, about 150 MB for base.en). */
export function loadStt() {
  asr ??= pipeline('automatic-speech-recognition', config.whisperModel, { dtype: 'q8' });
  return asr;
}

/**
 * The glasses send 16 kHz signed 16-bit little-endian mono PCM.
 * @param {Uint8Array | Buffer} pcm
 * @returns {Promise<string>}
 */
export async function transcribe(pcm) {
  const n = Math.floor(pcm.byteLength / 2);
  if (n < 1600) return ''; // under 0.1 s
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) audio[i] = view.getInt16(i * 2, true) / 32768;
  const out = await (await loadStt())(audio, { language: undefined, chunk_length_s: 30 });
  return String(out.text ?? '').trim();
}
