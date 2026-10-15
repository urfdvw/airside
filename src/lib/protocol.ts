export const PROTOCOL_VERSION = 4;
export const AUDIO_BITRATE = 128_000;
/** All streamed audio is 48 kHz stereo Opus in 20 ms packets. */
export const STREAM_SAMPLE_RATE = 48_000;
export const STREAM_CHANNELS = 2;
/** The desktop keeps up to this much encoded audio ahead of the phone's playback position. */
export const STREAM_AHEAD_SECONDS = 30;
/** The phone starts a stream once this much audio is buffered… */
export const START_BUFFER_SECONDS = 1;
/** …and after running dry it waits for this much before resuming. */
export const REBUFFER_SECONDS = 4;
export const PUBLIC_APP_URL = 'https://urfdvw.github.io/airside/';
export const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PIN_LENGTH = 4;
export const PEER_PREFIX = 'airside-';

export interface Track {
  id: string;
  name: string;
  path: string;
  size: number;
  format: string;
}

export type Phase = 'idle' | 'loading' | 'playing' | 'paused' | 'error';
export interface Playback {
  trackId: string | null;
  phase: Phase;
  position: number;
  duration: number;
  error: string | null;
}
export const emptyPlayback: Playback = { trackId: null, phase: 'idle', position: 0, duration: 0, error: null };

export type Command =
  | { type: 'play'; trackId?: string }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; position: number }
  | { type: 'shuffle'; enabled: boolean };
export type HostMessage =
  | { type: 'welcome'; version: number }
  | { type: 'library-start'; folder: string }
  | { type: 'library-chunk'; tracks: Track[] }
  | { type: 'library-end' }
  | { type: 'shuffle'; enabled: boolean }
  | StreamStart
  | AudioBatch
  | { type: 'stream-end'; streamId: number }
  | { type: 'state'; playback: Playback }
  | { type: 'error'; message: string }
  | { type: 'ping' };

/**
 * Starts a new audio stream on the phone, replacing any previous one (new track or seek).
 * `start` is the track position in seconds of the first frame; `frames` is how many frames the
 * stream plays after dropping the encoder's `preSkip` priming frames.
 */
export interface StreamStart { type: 'stream-start'; streamId: number; trackId: string; start: number; frames: number; preSkip: number }
/** Consecutive Opus packets, concatenated in `data`; `sizes` gives each packet's byte length. */
export interface AudioBatch { type: 'audio'; streamId: number; data: ArrayBuffer; sizes: number[] }

export type PlayerMessage =
  | { type: 'ready' }
  | { type: 'pong' }
  | { type: 'progress'; streamId: number; position: number; buffered: number }
  | { type: 'ended'; streamId: number };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCommand(value: unknown): value is Command {
  if (!isRecord(value)) return false;
  if (value.type === 'play') return value.trackId === undefined || typeof value.trackId === 'string';
  if (value.type === 'seek') return typeof value.position === 'number' && Number.isFinite(value.position) && value.position >= 0;
  if (value.type === 'shuffle') return typeof value.enabled === 'boolean';
  return ['pause', 'next', 'previous'].includes(String(value.type));
}

export function isStreamStart(value: unknown): value is StreamStart {
  return isRecord(value) && value.type === 'stream-start' && isCount(value.streamId) && typeof value.trackId === 'string'
    && isTime(value.start) && isCount(value.frames) && isCount(value.preSkip);
}

export function isAudioBatch(value: unknown): value is AudioBatch {
  if (!isRecord(value) || value.type !== 'audio' || !isCount(value.streamId) || !(value.data instanceof ArrayBuffer)) return false;
  const { sizes, data } = value;
  return Array.isArray(sizes) && sizes.every(isCount) && sizes.reduce((total: number, size: number) => total + size, 0) === data.byteLength;
}

export function isPlayerMessage(value: unknown): value is PlayerMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'progress') return isCount(value.streamId) && isTime(value.position) && isTime(value.buffered);
  if (value.type === 'ended') return isCount(value.streamId);
  return value.type === 'ready' || value.type === 'pong';
}

/** Splits an audio batch back into its Opus packets (views into `data`, no copies). */
export function splitPackets({ data, sizes }: Pick<AudioBatch, 'data' | 'sizes'>): Uint8Array[] {
  let offset = 0;
  return sizes.map((size) => { const packet = new Uint8Array(data, offset, size); offset += size; return packet; });
}

/** Concatenates Opus packets into one batch payload. */
export function joinPackets(packets: readonly Uint8Array[]): Pick<AudioBatch, 'data' | 'sizes'> {
  const sizes = packets.map((packet) => packet.byteLength);
  const data = new Uint8Array(sizes.reduce((total, size) => total + size, 0));
  let offset = 0;
  for (const packet of packets) { data.set(packet, offset); offset += packet.byteLength; }
  return { data: data.buffer, sizes };
}

/** Reads the pre-skip (encoder priming frames) from an OpusHead identification header. */
export function opusPreSkip(header: ArrayBuffer | ArrayBufferView | undefined, fallback = 312): number {
  if (!header) return fallback;
  const bytes = header instanceof ArrayBuffer ? new Uint8Array(header) : new Uint8Array(header.buffer, header.byteOffset, header.byteLength);
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 8)) !== 'OpusHead') return fallback;
  return bytes[10] | (bytes[11] << 8);
}

export function sortTracksByName<T extends Pick<Track, 'name' | 'path'>>(tracks: readonly T[]): T[] {
  return [...tracks].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
}

export function shuffleTracks<T extends Pick<Track, 'id'>>(tracks: readonly T[], previousOrder: readonly string[] = [], random = Math.random): T[] {
  const original = [...tracks];
  const shuffled = [...tracks];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  const matches = (order: readonly string[]) => order.length === shuffled.length && shuffled.every((track, index) => track.id === order[index]);
  if (shuffled.length > 1 && shuffled.every((track, index) => track.id === original[index].id)) shuffled.push(shuffled.shift()!);
  if (shuffled.length > 2 && matches(previousOrder)) {
    [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
    if (shuffled.every((track, index) => track.id === original[index].id)) shuffled.push(shuffled.shift()!);
  }
  return shuffled;
}

export function isPlayback(value: unknown): value is Playback {
  return isRecord(value) && (value.trackId === null || typeof value.trackId === 'string')
    && ['idle', 'loading', 'playing', 'paused', 'error'].includes(String(value.phase))
    && typeof value.position === 'number' && Number.isFinite(value.position) && value.position >= 0
    && typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration >= 0
    && (value.error === null || typeof value.error === 'string');
}

export function isTrack(value: unknown): value is Track {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && typeof value.path === 'string' && typeof value.format === 'string'
    && typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0;
}

export function createPin(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PIN_LENGTH));
  return Array.from(bytes, (byte) => PIN_ALPHABET[byte % PIN_ALPHABET.length]).join('');
}

export function normalizePin(value: string): string {
  return [...value.toUpperCase()].filter((letter) => PIN_ALPHABET.includes(letter)).join('').slice(0, PIN_LENGTH);
}

export function isPin(value: string): boolean {
  return value.length === PIN_LENGTH && [...value].every((letter) => PIN_ALPHABET.includes(letter));
}

export function hostPeerId(pin: string): string {
  if (!isPin(pin)) throw new Error('Enter a valid four-letter PIN.');
  return `${PEER_PREFIX}${pin.toLowerCase()}`;
}

export function playerUrl(base: string, peer: string, token: string): string {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http:// or https:// app URL.');
  url.search = '';
  url.hash = `/player?${new URLSearchParams({ peer, token })}`;
  return url.href;
}

export function pinPlayerUrl(base: string, pin: string): string {
  return playerUrl(base, hostPeerId(pin), pin);
}

export function loginUrl(base: string): string {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http:// or https:// app URL.');
  url.search = '';
  url.hash = '/login';
  return url.href;
}

export function pairingFromUrl(value: string): { peer: string; token: string } | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hash.startsWith('#/player?')) return null;
    const params = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1));
    const peer = params.get('peer') ?? '';
    const token = params.get('token') ?? '';
    if (!isPin(token) || peer !== hostPeerId(token)) return null;
    return { peer, token };
  } catch {
    return null;
  }
}

export function formatTime(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
