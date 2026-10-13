import type { OpusDecoder } from 'opus-decoder';
import { REBUFFER_SECONDS, START_BUFFER_SECONDS, STREAM_CHANNELS, STREAM_SAMPLE_RATE, splitPackets, type AudioBatch, type StreamStart } from './protocol';
import type { WorkletCommand, WorkletStatus } from './stream.worklet';
import workletUrl from './stream.worklet.ts?worker&url';

export interface StreamStatus {
  streamId: number;
  trackId: string;
  /** Track position in seconds of the audio currently being heard. */
  position: number;
  /** Seconds of decoded audio waiting to be played. */
  buffered: number;
  /** True while playback is held until enough audio arrives. */
  waiting: boolean;
  /** True once the whole stream has been played. */
  finished: boolean;
}

/**
 * Phone-side playback of the desktop's Opus stream. Packets are decoded with a WebAssembly Opus
 * decoder and handed to an AudioWorklet that plays them from a buffer at the device's own clock.
 * Output goes through a MediaStream into the page's <audio> element so the system treats it as
 * media playback (lock screen controls, background audio).
 */
export class StreamPlayer {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private graph: Promise<AudioWorkletNode> | null = null;
  private decoder: Promise<OpusDecoder> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stream: StreamStart | null = null;
  private playing = false;

  constructor(private audio: HTMLAudioElement, private onStatus: (status: StreamStatus) => void, private onError: (message: string) => void) {}

  get currentStream() { return this.stream; }

  private ensureGraph() {
    if (this.graph) return this.graph;
    const graph = (async () => {
      const context = new AudioContext({ sampleRate: STREAM_SAMPLE_RATE, latencyHint: 'playback' });
      this.context = context;
      await context.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(context, 'airside-stream', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [STREAM_CHANNELS] });
      node.port.onmessage = ({ data }: MessageEvent<WorkletStatus>) => this.status(data);
      this.post(node, { type: 'thresholds', start: START_BUFFER_SECONDS * STREAM_SAMPLE_RATE, rebuffer: REBUFFER_SECONDS * STREAM_SAMPLE_RATE });
      this.post(node, { type: 'playing', playing: this.playing });
      const destination = context.createMediaStreamDestination();
      node.connect(destination);
      this.audio.srcObject = destination.stream;
      this.node = node;
      return node;
    })();
    graph.catch(() => { if (this.graph === graph) this.graph = null; });
    return this.graph = graph;
  }

  private ensureDecoder() {
    if (this.decoder) return this.decoder;
    // Opus decoding runs in WebAssembly and is loaded only on the phone.
    const decoder = (async () => {
      const { OpusDecoder } = await import('opus-decoder');
      const instance = new OpusDecoder({ channels: STREAM_CHANNELS });
      await instance.ready;
      return instance;
    })();
    decoder.catch(() => { if (this.decoder === decoder) this.decoder = null; });
    return this.decoder = decoder;
  }

  private post(node: AudioWorkletNode, command: WorkletCommand, transfer: Transferable[] = []) {
    node.port.postMessage(command, transfer);
  }

  // Stream operations run strictly in arrival order.
  private enqueue(operation: () => Promise<void>) {
    this.queue = this.queue.then(operation).catch((error: unknown) => {
      this.onError(`Audio playback failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private status(data: WorkletStatus) {
    const stream = this.stream;
    if (!stream || data.streamId !== stream.streamId) return;
    this.onStatus({
      streamId: stream.streamId,
      trackId: stream.trackId,
      position: stream.start + data.played / STREAM_SAMPLE_RATE,
      buffered: data.buffered / STREAM_SAMPLE_RATE,
      waiting: data.waiting,
      finished: data.finished,
    });
  }

  start(stream: StreamStart) {
    this.stream = stream;
    this.enqueue(async () => {
      const [node, decoder] = await Promise.all([this.ensureGraph(), this.ensureDecoder()]);
      await decoder.reset();
      this.post(node, { type: 'reset', streamId: stream.streamId, frames: stream.frames, preSkip: stream.preSkip });
    });
  }

  push(batch: AudioBatch) {
    if (batch.streamId !== this.stream?.streamId) return;
    this.enqueue(async () => {
      const [node, decoder] = await Promise.all([this.ensureGraph(), this.ensureDecoder()]);
      if (batch.streamId !== this.stream?.streamId) return;
      const { channelData, samplesDecoded } = decoder.decodeFrames(splitPackets(batch));
      if (!samplesDecoded) return;
      const channels = channelData.slice(0, STREAM_CHANNELS).map((channel) => channel.length === samplesDecoded ? channel : channel.slice(0, samplesDecoded));
      this.post(node, { type: 'pcm', streamId: batch.streamId, channels }, channels.map((channel) => channel.buffer));
    });
  }

  end(streamId: number) {
    if (streamId !== this.stream?.streamId) return;
    this.enqueue(async () => { this.post(await this.ensureGraph(), { type: 'end', streamId }); });
  }

  /** Stops the current stream and forgets its audio. */
  clear() {
    this.stream = null;
    this.enqueue(async () => {
      if (this.node) this.post(this.node, { type: 'reset', streamId: -1, frames: 0, preSkip: 0 });
    });
  }

  setPlaying(playing: boolean) {
    if (playing === this.playing) return;
    this.playing = playing;
    if (this.node) this.post(this.node, { type: 'playing', playing });
  }

  /** Must run inside a user gesture on mobile browsers. */
  async resume() {
    const graph = this.ensureGraph();
    // Resume synchronously while the tap still counts as a user gesture (iOS is strict about this).
    const resumed = this.context?.resume();
    await graph;
    await resumed;
    await this.audio.play();
    return this.context?.state === 'running';
  }

  get ready() { return this.context?.state === 'running'; }

  destroy() {
    this.stream = null;
    this.node?.disconnect();
    this.node = null;
    void this.context?.close();
    this.context = null;
    this.graph = null;
    void this.decoder?.then((decoder) => decoder.free(), () => {});
    this.decoder = null;
  }
}
