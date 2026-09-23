import type { LocalTrack } from './library';
import { emptyPlayback, errorMessage, type Playback } from './protocol';

export class AudioEngine {
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private startedAt = 0;
  private offset = 0;
  private revision = 0;
  private wantsPlay = false;
  private state: Playback = { ...emptyPlayback };

  constructor(private onState: (state: Playback) => void, private onEnded: () => void) {}

  // Called directly from the desktop's folder button, within a user gesture.
  async unlock() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 48000 });
      this.destination = this.context.createMediaStreamDestination();
      this.destination.channelCount = 2;
      this.destination.channelCountMode = 'explicit';
      this.destination.channelInterpretation = 'speakers';
      this.destination.stream.getAudioTracks()[0].contentHint = 'music';
      // Intentionally never connect anything to context.destination (speakers).
      this.context.onstatechange = () => {
        if (this.context?.state === 'suspended' && this.state.phase === 'playing') {
          this.pause();
          this.update({ error: 'Desktop audio was suspended. Click Enable streaming on the desktop, then play again.' });
        }
      };
    }
    await this.context.resume();
  }

  get stream() { return this.destination?.stream ?? null; }
  get ready() { return this.context?.state === 'running'; }
  get snapshot(): Playback {
    const position = this.state.phase === 'playing' && this.context
      ? Math.min(this.state.duration, this.offset + this.context.currentTime - this.startedAt)
      : this.offset;
    return { ...this.state, position };
  }

  private update(patch: Partial<Playback>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.snapshot);
  }

  private stopSource() {
    if (this.source) {
      this.source.onended = null;
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
  }

  async select(track: LocalTrack) {
    const revision = ++this.revision;
    this.stopSource();
    this.buffer = null;
    this.offset = 0;
    this.wantsPlay = true;
    this.update({ trackId: track.id, duration: 0, phase: 'loading', error: null });
    try {
      if (!this.context || !this.ready) throw new Error('Click Enable streaming on the desktop first.');
      const file = await track.handle.getFile();
      const bytes = await file.arrayBuffer();
      if (revision !== this.revision) return;
      const buffer = await this.context.decodeAudioData(bytes);
      if (revision !== this.revision) return;
      this.buffer = buffer;
      this.update({ duration: buffer.duration, phase: 'paused' });
      if (this.wantsPlay) this.play();
    } catch (error) {
      if (revision !== this.revision) return;
      const message = error instanceof DOMException && error.name === 'EncodingError'
        ? 'This browser cannot decode this file. Try another track.' : errorMessage(error);
      this.update({ phase: 'error', error: message });
    }
  }

  play() {
    this.wantsPlay = true;
    if (this.state.phase === 'playing' || this.state.phase === 'loading') return;
    if (!this.context || !this.destination || !this.buffer) return;
    if (!this.ready) {
      this.update({ phase: 'paused', error: 'Click Enable streaming on the desktop, then play again.' });
      return;
    }
    if (this.offset >= this.buffer.duration) this.offset = 0;
    this.source = this.context.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.destination);
    this.source.onended = () => {
      this.stopSource();
      this.offset = this.buffer?.duration ?? 0;
      this.update({ phase: 'paused' });
      this.onEnded();
    };
    this.startedAt = this.context.currentTime;
    this.source.start(0, this.offset);
    this.update({ phase: 'playing', error: null });
  }

  pause() {
    this.wantsPlay = false;
    this.offset = this.snapshot.position;
    this.stopSource();
    if (this.state.phase === 'playing') this.update({ phase: 'paused' });
  }

  seek(position: number) {
    if (!this.buffer || !Number.isFinite(position)) return;
    const wasPlaying = this.state.phase === 'playing';
    this.stopSource();
    this.offset = Math.max(0, Math.min(this.buffer.duration, position));
    if (this.offset >= this.buffer.duration) {
      this.wantsPlay = false;
      this.update({ phase: 'paused', position: this.offset });
      return;
    }
    this.update({ phase: 'paused', position: this.offset, error: null });
    if (wasPlaying) this.play();
  }

  reset() {
    ++this.revision;
    this.stopSource();
    this.buffer = null;
    this.offset = 0;
    this.wantsPlay = false;
    this.update({ ...emptyPlayback });
  }

  destroy() {
    this.reset();
    this.destination?.stream.getTracks().forEach((track) => track.stop());
    if (this.context) { this.context.onstatechange = null; void this.context.close(); }
    this.context = null;
    this.destination = null;
  }
}
