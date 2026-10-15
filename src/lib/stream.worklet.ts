// AudioWorklet that plays a stream of decoded PCM at the audio device's own pace. When the network
// falls behind it outputs silence and waits for the buffer to refill; it never speeds up or slows
// down the music.

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(); }
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

export type WorkletCommand =
  | { type: 'reset'; streamId: number; frames: number; preSkip: number }
  | { type: 'pcm'; streamId: number; channels: Float32Array[] }
  | { type: 'end'; streamId: number }
  | { type: 'playing'; playing: boolean }
  | { type: 'thresholds'; start: number; rebuffer: number };

export interface WorkletStatus {
  type: 'status';
  streamId: number;
  played: number;
  buffered: number;
  waiting: boolean;
  finished: boolean;
}

interface Chunk { left: Float32Array; right: Float32Array; offset: number; end: number }

const REPORT_FRAMES = 4096; // ~85 ms

class StreamProcessor extends AudioWorkletProcessor {
  private chunks: Chunk[] = [];
  private streamId = -1;
  private buffered = 0;
  private skip = 0;
  private remaining = 0;
  private played = 0;
  private ended = false;
  private finished = false;
  private playing = false;
  private waiting = true;
  private startFrames = sampleRate;
  private rebufferFrames = 4 * sampleRate;
  private threshold = sampleRate;
  private sinceReport = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<WorkletCommand>) => this.receive(data);
  }

  private receive(message: WorkletCommand) {
    if (message.type === 'reset') {
      this.chunks = [];
      this.streamId = message.streamId;
      this.buffered = this.played = 0;
      this.skip = message.preSkip;
      this.remaining = message.frames;
      this.ended = message.frames === 0;
      this.finished = false;
      this.waiting = true;
      this.threshold = this.startFrames;
      this.report();
    } else if (message.type === 'pcm') {
      if (message.streamId !== this.streamId || !message.channels.length) return;
      const left = message.channels[0];
      const right = message.channels[1] ?? left;
      let offset = Math.min(this.skip, left.length);
      this.skip -= offset;
      // The encoder pads the last packet; never play past the declared length.
      const frames = Math.min(left.length - offset, this.remaining);
      if (frames > 0) {
        this.chunks.push({ left, right, offset, end: offset + frames });
        this.buffered += frames;
        this.remaining -= frames;
      }
      if (this.remaining === 0) this.ended = true;
    } else if (message.type === 'end') {
      if (message.streamId === this.streamId) this.ended = true;
    } else if (message.type === 'playing') {
      this.playing = message.playing;
      this.report();
    } else if (message.type === 'thresholds') {
      this.startFrames = message.start;
      this.rebufferFrames = message.rebuffer;
    }
  }

  private report() {
    this.sinceReport = 0;
    this.port.postMessage({ type: 'status', streamId: this.streamId, played: this.played, buffered: this.buffered, waiting: this.waiting, finished: this.finished } satisfies WorkletStatus);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? left;
    const size = left.length;
    this.sinceReport += size;
    let written = 0;

    if (this.playing && this.streamId >= 0 && !this.finished) {
      if (this.waiting && (this.buffered >= this.threshold || this.ended)) {
        this.waiting = false;
        this.report();
      }
      if (!this.waiting) {
        while (written < size && this.chunks.length) {
          const chunk = this.chunks[0];
          const count = Math.min(size - written, chunk.end - chunk.offset);
          left.set(chunk.left.subarray(chunk.offset, chunk.offset + count), written);
          right.set(chunk.right.subarray(chunk.offset, chunk.offset + count), written);
          chunk.offset += count;
          written += count;
          if (chunk.offset >= chunk.end) this.chunks.shift();
        }
        this.buffered -= written;
        this.played += written;
        if (written < size) {
          if (this.ended) this.finished = true;
          else { this.waiting = true; this.threshold = this.rebufferFrames; }
          this.report();
        }
      }
    }
    if (this.sinceReport >= REPORT_FRAMES) this.report();
    return true;
  }
}

registerProcessor('airside-stream', StreamProcessor);
