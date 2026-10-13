import type { StreamRequest } from './audio';
import { AUDIO_BITRATE, STREAM_AHEAD_SECONDS, STREAM_CHANNELS, STREAM_SAMPLE_RATE, joinPackets, opusPreSkip, type HostMessage } from './protocol';

const PACKET_FRAMES = STREAM_SAMPLE_RATE / 50; // 20 ms Opus packets
const INPUT_FRAMES = PACKET_FRAMES * 50; // feed the encoder one second at a time
const BATCH_PACKETS = 25; // half a second of audio per data-channel message
const ENCODE_AHEAD_FRAMES = 10 * STREAM_SAMPLE_RATE; // encoded but not yet sent
// Keep the data channel's send queue short so control messages are never stuck behind much audio.
const MAX_QUEUED_BYTES = 48 * 1024;

const encoderConfig: AudioEncoderConfig = {
  codec: 'opus',
  sampleRate: STREAM_SAMPLE_RATE,
  numberOfChannels: STREAM_CHANNELS,
  bitrate: AUDIO_BITRATE,
  opus: { frameDuration: 20_000, application: 'audio', complexity: 10 },
} as AudioEncoderConfig;

export async function isStreamingSupported() {
  if (typeof AudioEncoder === 'undefined') return false;
  try { return (await AudioEncoder.isConfigSupported(encoderConfig)).supported === true; }
  catch { return false; }
}

/** Stereo planar copy of `frames` frames from `start`, downmixing or duplicating channels as needed. */
function stereoSlice(buffer: AudioBuffer, start: number, frames: number) {
  const available = Math.max(0, Math.min(frames, buffer.length - start));
  const planar = new Float32Array(frames * 2); // zero-padded past the end of the track
  const left = planar.subarray(0, frames);
  const right = planar.subarray(frames);
  const channel = (index: number) => buffer.getChannelData(index).subarray(start, start + available);
  if (buffer.numberOfChannels === 1) {
    left.set(channel(0));
    right.set(channel(0));
  } else if (buffer.numberOfChannels === 6) {
    // 5.1 (L, R, C, LFE, SL, SR) to stereo, as Web Audio downmixes it.
    const [l, r, c, , sl, sr] = [0, 1, 2, 3, 4, 5].map(channel);
    for (let i = 0; i < available; i++) {
      left[i] = l[i] + Math.SQRT1_2 * (c[i] + sl[i]);
      right[i] = r[i] + Math.SQRT1_2 * (c[i] + sr[i]);
    }
  } else {
    left.set(channel(0));
    right.set(channel(1));
  }
  return planar;
}

interface Packet { data: Uint8Array; end: number }

/**
 * Encodes one stream with WebCodecs and sends it ahead of the phone's playback position over the
 * reliable data channel. Sending is paced by the phone's progress reports and the channel's send
 * queue, never by a real-time clock, so a slow network drains the phone's buffer instead of
 * changing the playback speed.
 */
export class StreamSender {
  private request: StreamRequest | null = null;
  private encoder: AudioEncoder | null = null;
  private packets: Packet[] = [];
  private inputFrame = 0;
  private inputDone = false;
  private encoderDone = false;
  private preSkip: number | null = null;
  private started = false;
  private finished = false;
  private sentFrames = 0;
  private playedFrames = 0;
  private channel: RTCDataChannel | null = null;
  private pumping = false;

  constructor(
    private send: (message: HostMessage) => void,
    private channelOf: () => { channel: RTCDataChannel; queued: number } | null,
    private onError: (message: string) => void,
  ) {}

  get streamId() { return this.request?.id ?? null; }

  start(request: StreamRequest) {
    this.stop();
    this.request = request;
    this.inputFrame = request.startFrame;
    const encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        if (this.encoder !== encoder) return;
        if (this.preSkip === null) {
          const description = metadata?.decoderConfig?.description;
          this.preSkip = opusPreSkip(description as ArrayBuffer | ArrayBufferView | undefined);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const end = Math.round((chunk.timestamp + (chunk.duration ?? 20_000)) * STREAM_SAMPLE_RATE / 1e6);
        this.packets.push({ data, end });
        this.pump();
      },
      error: (error) => {
        if (this.encoder !== encoder) return;
        this.stop();
        this.onError(`Audio encoding failed: ${error.message}`);
      },
    });
    encoder.configure(encoderConfig);
    encoder.addEventListener('dequeue', this.pump);
    this.encoder = encoder;
    this.pump();
  }

  stop() {
    this.encoder?.removeEventListener('dequeue', this.pump);
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.encoder = null;
    this.request = null;
    this.packets = [];
    this.inputDone = this.encoderDone = this.started = this.finished = false;
    this.preSkip = null;
    this.sentFrames = this.playedFrames = 0;
  }

  /** The phone's playback position (track seconds) in the given stream. */
  progress(streamId: number, position: number) {
    const request = this.request;
    if (!request || request.id !== streamId) return;
    this.playedFrames = Math.max(0, Math.round(position * STREAM_SAMPLE_RATE) - request.startFrame);
    this.pump();
  }

  /** Call when the data connection changes or drains. */
  pump = () => {
    if (this.pumping) return;
    this.pumping = true;
    try { this.fill(); } finally { this.pumping = false; }
  };

  private fill() {
    const request = this.request;
    const encoder = this.encoder;
    if (!request || !encoder) return;
    const total = request.buffer.length - request.startFrame;

    // Keep the encoder a few seconds ahead of what has been sent.
    while (!this.inputDone && encoder.encodeQueueSize < 2) {
      const queued = this.packets.length ? this.packets[this.packets.length - 1].end - this.sentFrames : 0;
      if (queued > ENCODE_AHEAD_FRAMES) break;
      // One extra packet of silence past the end so the encoder's look-ahead covers the last frames.
      const remaining = request.buffer.length + PACKET_FRAMES - this.inputFrame;
      const frames = Math.min(INPUT_FRAMES, Math.ceil(remaining / PACKET_FRAMES) * PACKET_FRAMES);
      encoder.encode(new AudioData({
        format: 'f32-planar',
        sampleRate: STREAM_SAMPLE_RATE,
        numberOfChannels: STREAM_CHANNELS,
        numberOfFrames: frames,
        timestamp: Math.round((this.inputFrame - request.startFrame) / STREAM_SAMPLE_RATE * 1e6),
        data: stereoSlice(request.buffer, this.inputFrame, frames),
      }));
      this.inputFrame += frames;
      if (this.inputFrame >= request.buffer.length + PACKET_FRAMES) {
        this.inputDone = true;
        encoder.flush().then(() => {
          if (this.encoder !== encoder) return;
          this.encoderDone = true;
          this.pump();
        }, () => { /* Reported through the error callback, or the stream was replaced. */ });
      }
    }

    const target = this.channelOf();
    if (!target) return;
    if (this.channel !== target.channel) {
      this.channel = target.channel;
      this.channel.bufferedAmountLowThreshold = MAX_QUEUED_BYTES / 2;
      this.channel.addEventListener('bufferedamountlow', this.pump);
    }

    if (!this.started) {
      if (this.preSkip === null) return; // wait for the first packet and its OpusHead
      this.send({ type: 'stream-start', streamId: request.id, trackId: request.trackId, start: request.startFrame / STREAM_SAMPLE_RATE, frames: total, preSkip: this.preSkip });
      this.started = true;
    }

    const ahead = STREAM_AHEAD_SECONDS * STREAM_SAMPLE_RATE;
    while (this.packets.length && this.sentFrames - this.playedFrames < ahead) {
      const queue = this.channelOf();
      if (!queue || queue.channel.bufferedAmount > MAX_QUEUED_BYTES || queue.queued > 0) return;
      const batch = this.packets.splice(0, BATCH_PACKETS);
      this.send({ type: 'audio', streamId: request.id, ...joinPackets(batch.map((packet) => packet.data)) });
      this.sentFrames = batch[batch.length - 1].end;
    }

    if (this.encoderDone && !this.packets.length && !this.finished) {
      this.finished = true;
      this.send({ type: 'stream-end', streamId: request.id });
    }
    // Sending made room for more encoding.
    if (!this.inputDone && encoder.encodeQueueSize < 2 && (!this.packets.length || this.packets[this.packets.length - 1].end - this.sentFrames <= ENCODE_AHEAD_FRAMES)) {
      queueMicrotask(this.pump);
    }
  }

  destroy() {
    this.stop();
    this.channel?.removeEventListener('bufferedamountlow', this.pump);
    this.channel = null;
  }
}
