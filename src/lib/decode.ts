import type { DecodeRequest, DecodeResponse } from './decoder.worker';

/** Formats no browser decodes natively; these skip straight to the fallback decoder. */
const FALLBACK_ONLY = new Set(['ape', 'wv', 'tak', 'wma', 'dsf', 'dff']);

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

function extensionOf(name: string) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function abortError() { return new DOMException('Decoding was cancelled.', 'AbortError'); }

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (response: DecodeResponse) => void; reject: (error: unknown) => void }>();

function failAll(error: unknown) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}

function stopWorker() {
  worker?.terminate();
  worker = null;
}

// The worker (and the libav.js wasm it imports) is only created the first time a file needs the fallback.
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<DecodeResponse>) => {
    const request = pending.get(data.id);
    pending.delete(data.id);
    request?.resolve(data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    stopWorker();
    failAll(new DecodeError('The fallback decoder could not start. Check your connection and reload the page.'));
  };
  return worker;
}

function libavBase() {
  return new URL(`${import.meta.env.BASE_URL}libav/`, document.baseURI).href;
}

async function decodeWithFallback(file: File, context: BaseAudioContext, signal?: AbortSignal): Promise<AudioBuffer> {
  signal?.throwIfAborted();
  const id = ++nextId;
  const target = getWorker();
  const response = await new Promise<DecodeResponse>((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id);
      // A running libav.js decode cannot be interrupted, so drop the worker; the next decode starts a fresh one.
      stopWorker();
      failAll(abortError());
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      resolve: (value) => { signal?.removeEventListener('abort', onAbort); resolve(value); },
      reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error); },
    });
    target.postMessage({ id, file, sampleRate: context.sampleRate, libavBase: libavBase() } satisfies DecodeRequest);
  });
  if (!response.ok) {
    console.warn(`Fallback decoding failed for ${file.name}:`, response.message);
    const format = extensionOf(file.name).toUpperCase() || 'this format';
    throw new DecodeError(response.stage === 'load'
      ? 'The fallback decoder could not be loaded. Check your connection and try again.'
      : `Could not decode this file (${format}). It may be damaged or use an unsupported codec.`);
  }
  // MEMORY: the whole track is held as Float32 PCM (see fallback-decode.ts); no streaming yet.
  const { channels, sampleRate } = response;
  const buffer = new AudioBuffer({ length: channels[0].length, numberOfChannels: channels.length, sampleRate });
  channels.forEach((data, index) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, index));
  return buffer;
}

/**
 * Decodes a whole audio file to an AudioBuffer. Native Web Audio decoding is tried first; if the
 * browser cannot decode the file, the libav.js fallback decoder is loaded on demand and used instead.
 */
export async function decodeFile(file: File, context: BaseAudioContext, signal?: AbortSignal): Promise<AudioBuffer> {
  if (!FALLBACK_ONLY.has(extensionOf(file.name))) {
    const bytes = await file.arrayBuffer();
    signal?.throwIfAborted();
    try {
      return await context.decodeAudioData(bytes);
    } catch (error) {
      signal?.throwIfAborted();
      console.info(`Native decoding failed for ${file.name}; trying the fallback decoder.`, error);
    }
  }
  return decodeWithFallback(file, context, signal);
}
