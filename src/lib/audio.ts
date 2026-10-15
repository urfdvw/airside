import { decodeFile } from './decode';
import type { LocalTrack } from './library';
import { STREAM_SAMPLE_RATE, emptyPlayback, errorMessage, type Playback } from './protocol';

/** A request to (re)start streaming `buffer` to the phone from `startFrame`. */
export interface StreamRequest {
  id: number;
  trackId: string;
  buffer: AudioBuffer;
  startFrame: number;
}

/**
 * Desktop playback state. The desktop no longer plays audio itself: it decodes the selected track
 * and asks for it to be streamed from a position. The phone plays the stream and reports its
 * position, which becomes the authoritative playback position.
 */
export class PlaybackEngine {
  private context: OfflineAudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private revision = 0;
  private streamId = 0;
  private decoding: AbortController | null = null;
  private wantsPlay = false;
  private state: Playback = { ...emptyPlayback };

  constructor(
    private onState: (state: Playback) => void,
    private onStream: (request: StreamRequest | null) => void,
    private onEnded: () => void,
  ) {}

  get snapshot(): Playback { return { ...this.state }; }

  private update(patch: Partial<Playback>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.snapshot);
  }

  // Decoding needs no user gesture or output device, so an offline context is enough.
  // Every track is decoded to 48 kHz, the rate that is encoded and streamed.
  private get decodeContext() {
    this.context ??= new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: STREAM_SAMPLE_RATE });
    return this.context;
  }

  private startStream(position: number) {
    if (!this.buffer || !this.state.trackId) return;
    const startFrame = Math.min(this.buffer.length, Math.round(position * STREAM_SAMPLE_RATE));
    this.onStream({ id: ++this.streamId, trackId: this.state.trackId, buffer: this.buffer, startFrame });
  }

  async select(track: LocalTrack) {
    const revision = ++this.revision;
    this.decoding?.abort();
    const decoding = this.decoding = new AbortController();
    this.buffer = null;
    this.wantsPlay = true;
    this.onStream(null);
    this.update({ trackId: track.id, duration: 0, position: 0, phase: 'loading', error: null });
    try {
      const file = await track.handle.getFile();
      if (revision !== this.revision) return;
      // Whole-file decode: large or high-rate tracks (e.g. DSD) cost a lot of memory as PCM.
      const buffer = await decodeFile(file, this.decodeContext, decoding.signal);
      if (revision !== this.revision) return;
      this.buffer = buffer;
      this.update({ duration: buffer.duration, position: 0, phase: this.wantsPlay ? 'playing' : 'paused' });
      this.startStream(0);
    } catch (error) {
      if (revision !== this.revision) return;
      this.update({ phase: 'error', error: errorMessage(error) });
    }
  }

  play() {
    this.wantsPlay = true;
    if (!this.buffer || this.state.phase === 'playing' || this.state.phase === 'loading') return;
    if (this.state.position >= this.buffer.duration - 0.05) {
      this.update({ position: 0, phase: 'playing', error: null });
      this.startStream(0);
      return;
    }
    this.update({ phase: 'playing', error: null });
  }

  pause() {
    this.wantsPlay = false;
    if (this.state.phase === 'playing') this.update({ phase: 'paused' });
  }

  seek(position: number) {
    if (!this.buffer || !Number.isFinite(position)) return;
    const target = Math.max(0, Math.min(this.buffer.duration, position));
    const atEnd = target >= this.buffer.duration;
    if (atEnd) this.wantsPlay = false;
    this.update({ position: target, error: null, ...(atEnd && this.state.phase === 'playing' ? { phase: 'paused' as const } : {}) });
    if (!atEnd) this.startStream(target);
  }

  /** Restarts the stream at the current position, e.g. when a phone (re)connects. */
  restartStream() {
    if (this.buffer && this.state.position < this.buffer.duration) this.startStream(this.state.position);
  }

  /** Position reported by the phone for the stream it is playing. */
  report(streamId: number, position: number) {
    if (streamId !== this.streamId || !this.buffer) return;
    this.state = { ...this.state, position: Math.min(this.buffer.duration, position) };
  }

  /** The phone played the stream to its end. */
  ended(streamId: number) {
    if (streamId !== this.streamId || !this.buffer) return;
    const wasPlaying = this.state.phase === 'playing';
    this.update({ position: this.buffer.duration, phase: 'paused' });
    if (wasPlaying) this.onEnded();
  }

  /** Streaming failed for the current track. */
  fail(message: string) {
    this.wantsPlay = false;
    this.onStream(null);
    this.update({ phase: 'error', error: message });
  }

  reset() {
    ++this.revision;
    this.decoding?.abort();
    this.decoding = null;
    this.buffer = null;
    this.wantsPlay = false;
    this.onStream(null);
    this.update({ ...emptyPlayback });
  }

  destroy() {
    this.reset();
    this.context = null;
  }
}
