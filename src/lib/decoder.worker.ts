/// <reference lib="webworker" />
import type LibAVTypes from '@libav.js/types';
import { decodeWithLibAV } from './fallback-decode';

export interface DecodeRequest { id: number; file: Blob; sampleRate: number; libavBase: string }
export type DecodeResponse =
  | { id: number; ok: true; sampleRate: number; channels: Float32Array[] }
  | { id: number; ok: false; stage: 'load' | 'decode'; message: string };

const LIBAV_FRONTEND = 'libav-6.10.9.0-airside.mjs';

declare const self: DedicatedWorkerGlobalScope;

let libavPromise: Promise<LibAVTypes.LibAV> | null = null;

// libav.js runs synchronously ("direct" mode) inside this worker, so the page never blocks on it.
// It is single-threaded: GitHub Pages cannot send COOP/COEP headers, so SharedArrayBuffer is unavailable.
function loadLibAV(base: string) {
  libavPromise ??= (async () => {
    const module = await import(/* @vite-ignore */ `${base}${LIBAV_FRONTEND}`) as { default: LibAVTypes.LibAVWrapper };
    return module.default.LibAV({ noworker: true, nothreads: true, base });
  })();
  libavPromise.catch(() => { libavPromise = null; });
  return libavPromise;
}

self.onmessage = async ({ data }: MessageEvent<DecodeRequest>) => {
  const { id, file, sampleRate, libavBase } = data;
  let libav: LibAVTypes.LibAV;
  try {
    libav = await loadLibAV(libavBase);
  } catch (error) {
    self.postMessage({ id, ok: false, stage: 'load', message: error instanceof Error ? error.message : String(error) } satisfies DecodeResponse);
    return;
  }
  try {
    const pcm = await decodeWithLibAV(libav, file, sampleRate);
    self.postMessage({ id, ok: true, ...pcm } satisfies DecodeResponse, pcm.channels.map((channel) => channel.buffer));
  } catch (error) {
    self.postMessage({ id, ok: false, stage: 'decode', message: error instanceof Error ? error.message : String(error) } satisfies DecodeResponse);
  }
};
