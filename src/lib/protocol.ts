export const PROTOCOL_VERSION = 1;
export const AUDIO_BITRATE = 320_000;
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

export interface ByteSample { bytes: number; timestamp: number }

export function measuredBitrateKbps(previous: ByteSample, current: ByteSample): number | null {
  const elapsedMs = current.timestamp - previous.timestamp;
  const receivedBytes = current.bytes - previous.bytes;
  if (elapsedMs <= 0 || receivedBytes < 0) return null;
  return Math.round((receivedBytes * 8) / elapsedMs);
}

export type Command =
  | { type: 'play'; trackId?: string }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; position: number };
export type HostMessage =
  | { type: 'welcome'; version: number }
  | { type: 'library-start'; folder: string }
  | { type: 'library-chunk'; tracks: Track[] }
  | { type: 'library-end' }
  | { type: 'state'; playback: Playback }
  | { type: 'error'; message: string }
  | { type: 'ping' };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCommand(value: unknown): value is Command {
  if (!isRecord(value)) return false;
  if (value.type === 'play') return value.trackId === undefined || typeof value.trackId === 'string';
  if (value.type === 'seek') return typeof value.position === 'number' && Number.isFinite(value.position) && value.position >= 0;
  return ['pause', 'next', 'previous'].includes(String(value.type));
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

// The receiver's answer must request stereo as well as the sender's offer.
// Touch only Opus payloads in audio sections; preserve ICE and other codecs.
export function stereoOpusSdp(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  let inAudio = false;
  let opus: string | undefined;
  const result: string[] = [];
  for (const line of lines) {
    if (line.startsWith('m=')) {
      inAudio = line.startsWith('m=audio ');
      opus = undefined;
    }
    const match = inAudio && line.match(/^a=rtpmap:(\d+) opus\/48000\/2$/i);
    if (match) opus = match[1];
    if (opus && line.startsWith(`a=fmtp:${opus} `)) {
      const params = new Map(line.slice(line.indexOf(' ') + 1).split(';').map((p) => {
        const [key, value] = p.trim().split('=');
        return [key, value] as const;
      }));
      params.set('stereo', '1');
      params.set('sprop-stereo', '1');
      params.set('maxaveragebitrate', String(AUDIO_BITRATE));
      params.set('usedtx', '0');
      result.push(`a=fmtp:${opus} ${Array.from(params, ([k, v]) => `${k}=${v}`).join(';')}`);
    } else {
      result.push(line);
      if (match && !lines.some((l) => l.startsWith(`a=fmtp:${opus} `))) {
        result.push(`a=fmtp:${opus} stereo=1;sprop-stereo=1;maxaveragebitrate=${AUDIO_BITRATE};usedtx=0`);
      }
    }
  }
  return result.join('\r\n');
}

export function formatTime(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
