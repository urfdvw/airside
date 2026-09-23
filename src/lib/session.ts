import Peer, { type DataConnection } from 'peerjs';
import { AudioEngine } from './audio';
import { publicTrack, scanFolder, type LocalTrack } from './library';
import { AUDIO_BITRATE, PROTOCOL_VERSION, createPin, emptyPlayback, errorMessage, hostPeerId, isCommand, isPlayback, isRecord, isTrack, measuredBitrateKbps, stereoOpusSdp, type ByteSample, type Command, type HostMessage, type Playback, type Track } from './protocol';

class Store<T> {
  private listeners = new Set<() => void>();
  constructor(protected state: T) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  protected patch(patch: Partial<T>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

function peerError(error: unknown): string {
  const type = isRecord(error) ? error.type : '';
  if (type === 'peer-unavailable') return 'Desktop not found. Keep its tab open and use its latest player link.';
  if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(String(type))) {
    return 'Could not reach PeerJS’s public signaling service. Check your internet connection and retry.';
  }
  return errorMessage(error);
}

function isSignalingFailure(error: unknown): boolean {
  const type = isRecord(error) ? String(error.type) : '';
  return ['disconnected', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(type);
}

export interface HostState {
  peerId: string;
  pin: string;
  token: string;
  signaling: 'connecting' | 'online' | 'offline';
  connected: boolean;
  streaming: boolean;
  audioReady: boolean;
  scanning: boolean;
  scanCount: number;
  skipped: number;
  folder: string;
  tracks: Track[];
  playback: Playback;
  error: string | null;
  quality: string | null;
}

export class HostSession extends Store<HostState> {
  private peer: Peer | null = null;
  private connection: DataConnection | null = null;
  private mediaSender: RTCRtpSender | null = null;
  private mediaNegotiating = false;
  private mediaRetryTimer?: ReturnType<typeof setTimeout>;
  private localTracks: LocalTrack[] = [];
  private scan: AbortController | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private signalTimer?: ReturnType<typeof setTimeout>;
  private peerReconnectTimer?: ReturnType<typeof setTimeout>;
  private lastPong = 0;
  private lastPing = 0;
  private engine: AudioEngine;
  private disposed = false;

  constructor() {
    const pin = createPin();
    super({ peerId: '', pin, token: pin, signaling: 'connecting', connected: false, streaming: false, audioReady: false, scanning: false, scanCount: 0, skipped: 0, folder: '', tracks: [], playback: { ...emptyPlayback }, error: null, quality: null });
    this.engine = new AudioEngine((playback) => {
      this.patch({ playback, audioReady: this.engine.ready });
      this.send({ type: 'state', playback });
    }, () => this.move(1, false));
  }

  start() {
    this.disposed = false;
    this.openPeer();
    this.timer = setInterval(() => {
      const playback = this.engine.snapshot;
      this.patch({ playback, audioReady: this.engine.ready });
      this.send({ type: 'state', playback });
      if (this.connection?.open && Date.now() - this.lastPing > 5000) {
        this.lastPing = Date.now();
        this.send({ type: 'ping' });
        if (Date.now() - this.lastPong > 25000) this.disconnect();
      }
    }, 500);
  }

  private openPeer() {
    this.patch({ signaling: 'connecting', error: null });
    // No custom host, API key, signaling server, or application backend.
    const peer = new Peer(hostPeerId(this.state.pin));
    this.peer = peer;
    clearTimeout(this.signalTimer);
    this.signalTimer = setTimeout(() => {
      if (this.state.signaling === 'connecting') this.patch({ signaling: 'offline', error: 'PeerJS is taking too long to connect. Check your internet connection and retry.' });
    }, 15000);
    peer.on('open', (peerId) => {
      if (this.peer !== peer) return;
      clearTimeout(this.signalTimer);
      clearTimeout(this.peerReconnectTimer);
      this.patch({ peerId, signaling: 'online', error: null });
      if (this.connection?.open) this.ensureMedia();
    });
    peer.on('connection', (connection) => { if (this.peer === peer) this.accept(connection); else connection.close(); });
    peer.on('call', (call) => call.close());
    peer.on('disconnected', () => {
      if (this.peer !== peer) return;
      this.patch({ signaling: 'offline' });
      this.scheduleSignalingReconnect(peer);
    });
    peer.on('error', (error) => {
      if (this.peer !== peer) return;
      const type = isRecord(error) ? error.type : '';
      if (type === 'unavailable-id' && !this.state.connected) {
        peer.destroy();
        const pin = createPin();
        this.patch({ peerId: '', pin, token: pin });
        this.openPeer();
        return;
      }
      if (isSignalingFailure(error) && this.connection?.open) {
        this.patch({ error: null, signaling: 'offline' });
        this.scheduleSignalingReconnect(peer);
        return;
      }
      this.patch({ error: peerError(error), signaling: peer.disconnected || peer.destroyed ? 'offline' : this.state.signaling });
    });
  }

  private scheduleSignalingReconnect(peer: Peer) {
    clearTimeout(this.peerReconnectTimer);
    this.peerReconnectTimer = setTimeout(() => {
      if (this.disposed || this.peer !== peer || peer.destroyed || !peer.disconnected) return;
      this.patch({ signaling: 'connecting', error: null });
      try { peer.reconnect(); }
      catch { this.patch({ signaling: 'offline' }); }
    }, 750);
  }

  retry = () => {
    if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
      this.patch({ signaling: 'connecting', error: null });
      this.peer.reconnect();
    } else if (!this.state.connected) {
      this.peer?.destroy();
      this.openPeer();
    }
  };

  private send(message: HostMessage) {
    if (this.connection?.open) {
      try { this.connection.send(message); } catch { this.disconnect(); }
    }
  }

  private accept(connection: DataConnection) {
    const meta: unknown = connection.metadata;
    const valid = isRecord(meta) && meta.token === this.state.token && meta.version === PROTOCOL_VERSION;
    const busy = this.connection !== null;
    if (!valid || busy) {
      connection.on('error', () => {});
      connection.on('open', () => {
        connection.send({ type: 'error', message: valid ? 'Another player is connected. Disconnect it on the desktop first.' : 'This pairing link is invalid. Scan the current desktop QR code.' });
        setTimeout(() => connection.close(), 300);
      });
      return;
    }
    this.connection = connection;
    connection.on('open', () => {
      if (this.connection !== connection) return;
      this.lastPong = Date.now();
      this.patch({ connected: true, error: null });
      this.send({ type: 'welcome', version: PROTOCOL_VERSION });
      this.sendLibrary();
      this.send({ type: 'state', playback: this.engine.snapshot });
    });
    connection.on('data', (data: unknown) => {
      if (this.connection !== connection) return;
      if (isRecord(data) && data.type === 'pong') this.lastPong = Date.now();
      else if (isRecord(data) && data.type === 'ready') this.ensureMedia();
      else if (isRecord(data) && data.type === 'media-answer' && typeof data.sdp === 'string') void this.acceptMediaAnswer(data.sdp);
      else if (isCommand(data)) this.command(data);
    });
    connection.on('close', () => { if (this.connection === connection) this.disconnect(); });
    connection.on('error', (error) => {
      if (this.connection === connection) { this.disconnect(); this.patch({ error: peerError(error) }); }
    });
  }

  private sendLibrary() {
    this.send({ type: 'library-start', folder: this.state.folder });
    for (let index = 0; index < this.state.tracks.length; index += 100) {
      this.send({ type: 'library-chunk', tracks: this.state.tracks.slice(index, index + 100) });
    }
    this.send({ type: 'library-end' });
  }

  private async ensureMedia() {
    const connection = this.connection;
    const stream = this.engine.stream;
    if (!connection?.open || !stream || this.mediaNegotiating || this.state.streaming) return;
    const pc = connection.peerConnection;
    if (pc.signalingState !== 'stable') return;
    this.mediaNegotiating = true;
    clearTimeout(this.mediaRetryTimer);
    try {
      if (!this.mediaSender) {
        const track = stream.getAudioTracks()[0];
        if (!track) throw new Error('No audio track is available.');
        this.mediaSender = pc.addTrack(track, stream);
      }
      const offer = await pc.createOffer();
      const sdp = stereoOpusSdp(offer.sdp ?? '');
      await pc.setLocalDescription({ type: 'offer', sdp });
      if (this.connection !== connection) return;
      this.send({ type: 'media-offer', sdp: pc.localDescription?.sdp ?? sdp });
      this.scheduleMediaNegotiationRetry(connection, pc, 5000);
    } catch (error) {
      this.patch({ error: errorMessage(error), streaming: false });
      this.send({ type: 'error', message: 'Audio negotiation failed. Retrying…' });
      this.scheduleMediaNegotiationRetry(connection, pc);
    }
  }

  private async acceptMediaAnswer(sdp: string) {
    const connection = this.connection;
    if (!connection?.open || !this.mediaNegotiating) return;
    const pc = connection.peerConnection;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      if (this.connection !== connection) return;
      clearTimeout(this.mediaRetryTimer);
      this.mediaNegotiating = false;
      this.patch({ streaming: true, error: null });
      await this.configureAudio(pc);
    } catch (error) {
      this.patch({ streaming: false, error: errorMessage(error) });
      this.send({ type: 'error', message: 'Audio negotiation failed. Retrying…' });
      this.scheduleMediaNegotiationRetry(connection, pc);
    }
  }

  private scheduleMediaNegotiationRetry(connection: DataConnection, pc: RTCPeerConnection, delay = 1500) {
    clearTimeout(this.mediaRetryTimer);
    this.mediaRetryTimer = setTimeout(() => {
      void (async () => {
        if (this.connection !== connection || !connection.open || this.state.streaming) return;
        if (pc.signalingState === 'have-local-offer') {
          try { await pc.setLocalDescription({ type: 'rollback' }); } catch { /* The next ready message can retry. */ }
        }
        this.mediaNegotiating = false;
        await this.ensureMedia();
      })();
    }, delay);
  }

  private async configureAudio(pc: RTCPeerConnection) {
    try {
      const sender = pc.getSenders().find((sender) => sender.track?.kind === 'audio');
      if (!sender) throw new Error('No audio sender');
      const params = sender.getParameters();
      if (!params.encodings?.length) throw new Error('No audio encoding');
      params.encodings.forEach((encoding) => { encoding.maxBitrate = AUDIO_BITRATE; });
      await sender.setParameters(params);
      const answer = pc.remoteDescription?.sdp ?? '';
      const stereo = /(?:^|[; ])stereo=1(?:;|\r?$)/m.test(answer);
      if (this.connection?.peerConnection === pc) this.patch({ quality: stereo ? 'Opus · stereo negotiated' : 'Stereo was not confirmed by this browser.' });
    } catch {
      if (this.connection?.peerConnection === pc) this.patch({ quality: 'This browser could not enforce the 320 kbps cap.' });
    }
  }

  enableAudio = async () => {
    try {
      await this.engine.unlock();
      if (this.disposed) return;
      this.patch({ audioReady: this.engine.ready, error: null });
      this.ensureMedia();
    } catch (error) { this.patch({ error: errorMessage(error) }); }
  };

  openFolder = async () => {
    if (!window.isSecureContext || !('showDirectoryPicker' in window)) {
      this.patch({ error: 'Folder access needs desktop Chrome or Edge on HTTPS or localhost.' });
      return;
    }
    this.patch({ scanning: true, scanCount: 0, error: null });
    try {
      // Both APIs are invoked before awaiting, while the click is still active.
      const unlocking = this.enableAudio();
      const directory = await window.showDirectoryPicker({ mode: 'read', id: 'airside-library', startIn: 'music' });
      await unlocking;
      if (this.disposed) return;
      this.scan?.abort();
      const scan = new AbortController();
      this.scan = scan;
      const { tracks, skipped } = await scanFolder(directory, scan.signal, (scanCount) => this.patch({ scanCount }));
      if (this.disposed || scan.signal.aborted) return;
      this.engine.reset();
      this.localTracks = tracks;
      this.patch({ folder: directory.name, tracks: tracks.map(publicTrack), skipped, error: null });
      this.sendLibrary();
      this.ensureMedia();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.patch({ error: errorMessage(error) });
    } finally { if (!this.disposed) this.patch({ scanning: false }); }
  };

  command = (command: Command) => {
    if (command.type === 'pause') { this.engine.pause(); return; }
    if (command.type === 'next') { this.move(1); return; }
    if (command.type === 'previous') { this.move(-1); return; }
    if (command.type === 'seek') { this.engine.seek(command.position); return; }
    const id = command.trackId;
    if (id) {
      const track = this.localTracks.find((track) => track.id === id);
      if (track) void this.engine.select(track);
    } else if (this.engine.snapshot.trackId && this.engine.snapshot.phase !== 'error') {
      this.engine.play();
    } else {
      const track = this.localTracks.find((track) => track.id === this.state.playback.trackId) ?? this.localTracks[0];
      if (track) void this.engine.select(track);
    }
  };

  private move(direction: number, wrap = true) {
    if (!this.localTracks.length) return;
    const current = this.localTracks.findIndex((track) => track.id === this.engine.snapshot.trackId);
    let next = current < 0 ? 0 : current + direction;
    if (!wrap && next >= this.localTracks.length) return;
    next = (next + this.localTracks.length) % this.localTracks.length;
    void this.engine.select(this.localTracks[next]);
  }

  private closeMedia() {
    clearTimeout(this.mediaRetryTimer);
    this.mediaSender = null;
    this.mediaNegotiating = false;
    this.patch({ streaming: false, quality: null });
  }

  disconnect = () => {
    const connection = this.connection;
    this.connection = null;
    this.closeMedia();
    connection?.close();
    this.engine.pause();
    this.patch({ connected: false });
  };

  destroy() {
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.signalTimer);
    clearTimeout(this.peerReconnectTimer);
    this.scan?.abort();
    this.disconnect();
    this.peer?.destroy();
    this.engine.destroy();
  }
}

export interface PlayerState {
  status: 'connecting' | 'connected' | 'disconnected';
  tracks: Track[];
  folder: string;
  loadingLibrary: boolean;
  playback: Playback;
  streamReady: boolean;
  audioEnabled: boolean;
  bitrateKbps: number | null;
  volume: number;
  error: string | null;
}

export class PlayerSession extends Store<PlayerState> {
  private peer: Peer | null = null;
  private connection: DataConnection | null = null;
  private audio = new Audio();
  private timer?: ReturnType<typeof setInterval>;
  private playbackTimer?: ReturnType<typeof setInterval>;
  private playbackTick = 0;
  private lastMessage = 0;
  private pendingTracks: Track[] = [];
  private receivedError = false;
  private generation = 0;
  private bitrateSample: ByteSample | null = null;
  private measuringBitrate = false;
  private volumeFrame = 0;
  private volumeTarget = 1;
  private signalingReconnectTimer?: ReturnType<typeof setTimeout>;
  private mediaRetryTimer?: ReturnType<typeof setTimeout>;

  constructor(private hostId: string, private token: string) {
    super({ status: 'connecting', tracks: [], folder: '', loadingLibrary: false, playback: { ...emptyPlayback }, streamReady: false, audioEnabled: false, bitrateKbps: null, volume: 1, error: null });
    this.audio.setAttribute('playsinline', '');
    this.audio.autoplay = true;
  }

  start = () => {
    this.cleanup();
    const generation = ++this.generation;
    this.receivedError = false;
    if (!this.hostId || !this.token) {
      this.patch({ status: 'disconnected', error: 'Open the player link or scan the QR code on your desktop to connect.' });
      return;
    }
    this.bitrateSample = null;
    this.playbackTick = performance.now();
    this.patch({ status: 'connecting', error: null, audioEnabled: false, streamReady: false, bitrateKbps: null });
    this.lastMessage = Date.now();
    const peer = new Peer();
    this.peer = peer;
    peer.on('open', () => {
      if (generation !== this.generation) return;
      clearTimeout(this.signalingReconnectTimer);
      if (this.connection) {
        if (this.connection.open) this.connection.send({ type: 'ready' });
        return;
      }
      const connection = peer.connect(this.hostId, { reliable: true, metadata: { token: this.token, version: PROTOCOL_VERSION } });
      this.connection = connection;
      connection.peerConnection.addEventListener('track', (event) => {
        if (generation !== this.generation || this.connection !== connection || event.track.kind !== 'audio') return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.audio.srcObject = stream;
        this.bitrateSample = null;
        this.receivedError = false;
        clearTimeout(this.mediaRetryTimer);
        this.patch({ streamReady: true, bitrateKbps: null, error: null });
        void this.enableAudio();
      });
      connection.on('data', (data: unknown) => { if (generation === this.generation) this.receive(data); });
      connection.on('close', () => { if (generation === this.generation) this.lost(); });
      connection.on('error', (error) => { if (generation === this.generation) this.lost(peerError(error)); });
    });
    peer.on('call', (call) => call.close());
    peer.on('error', (error) => {
      if (generation !== this.generation) return;
      if (isSignalingFailure(error) && this.state.status === 'connected' && this.connection?.open) {
        this.scheduleSignalingReconnect(peer, generation);
        return;
      }
      this.lost(peerError(error));
    });
    peer.on('disconnected', () => {
      // Existing WebRTC connections survive signaling interruptions.
      if (generation !== this.generation) return;
      if (this.state.status === 'connected' && this.connection?.open) this.scheduleSignalingReconnect(peer, generation);
      else this.lost();
    });
    this.timer = setInterval(() => {
      void this.measureBitrate();
      if (Date.now() - this.lastMessage > 20000) this.lost(this.state.status === 'connecting'
        ? 'Connection timed out. Check that the desktop is online. Some networks block direct connections.'
        : 'Desktop connection lost. Keep its tab open and tap Reconnect.');
    }, 1000);
    this.playbackTimer = setInterval(() => this.advancePlaybackClock(), 250);
  };

  private scheduleSignalingReconnect(peer: Peer, generation: number) {
    clearTimeout(this.signalingReconnectTimer);
    this.signalingReconnectTimer = setTimeout(() => {
      if (generation !== this.generation || this.peer !== peer || peer.destroyed || !peer.disconnected) return;
      try { peer.reconnect(); } catch { /* Keep the active WebRTC connection alive. */ }
    }, 750);
  }

  private scheduleMediaRetry(generation: number) {
    clearTimeout(this.mediaRetryTimer);
    this.mediaRetryTimer = setTimeout(() => {
      if (generation === this.generation && this.state.status === 'connected' && this.connection?.open && !this.state.streamReady) {
        this.connection.send({ type: 'ready' });
      }
    }, 1500);
  }

  private advancePlaybackClock() {
    const now = performance.now();
    const elapsed = Math.max(0, (now - this.playbackTick) / 1000);
    this.playbackTick = now;
    const playback = this.state.playback;
    if (playback.phase !== 'playing' || !playback.duration || elapsed <= 0) return;
    const position = Math.min(playback.duration, playback.position + elapsed);
    if (position !== playback.position) this.patch({ playback: { ...playback, position } });
  }

  private receive(data: unknown) {
    if (!isRecord(data)) return;
    this.lastMessage = Date.now();
    if (data.type === 'welcome' && data.version === PROTOCOL_VERSION) {
      this.patch({ status: 'connected', error: null });
      this.connection?.send({ type: 'ready' });
    } else if (data.type === 'library-start' && typeof data.folder === 'string') {
      this.pendingTracks = [];
      this.patch({ folder: data.folder, loadingLibrary: true });
    } else if (data.type === 'library-chunk' && Array.isArray(data.tracks) && data.tracks.every(isTrack)) {
      this.pendingTracks.push(...data.tracks);
    } else if (data.type === 'library-end') {
      this.patch({ tracks: this.pendingTracks, loadingLibrary: false });
    } else if (data.type === 'media-offer' && typeof data.sdp === 'string') {
      void this.acceptMediaOffer(data.sdp);
    } else if (data.type === 'state' && isPlayback(data.playback)) {
      this.playbackTick = performance.now();
      const started = data.playback.phase === 'playing' && this.state.playback.phase !== 'playing';
      if (started) this.bitrateSample = null;
      this.patch({ playback: data.playback, ...(started || data.playback.phase !== 'playing' ? { bitrateKbps: null } : {}) });
      this.updateMediaSession();
    } else if (data.type === 'error' && typeof data.message === 'string') {
      this.receivedError = true;
      this.patch({ error: data.message });
      if (data.message.startsWith('Audio negotiation')) this.scheduleMediaRetry(this.generation);
    } else if (data.type === 'ping') {
      this.connection?.send({ type: 'pong' });
    }
  }

  private async acceptMediaOffer(sdp: string) {
    const connection = this.connection;
    if (!connection?.open) return;
    const pc = connection.peerConnection;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      const answerSdp = stereoOpusSdp(answer.sdp ?? '');
      await pc.setLocalDescription({ type: 'answer', sdp: answerSdp });
      if (this.connection !== connection) return;
      connection.send({ type: 'media-answer', sdp: pc.localDescription?.sdp ?? answerSdp });
    } catch (error) {
      this.patch({ error: `Audio negotiation failed: ${errorMessage(error)}`, streamReady: false });
      this.scheduleMediaRetry(this.generation);
    }
  }

  enableAudio = async () => {
    if (!this.audio.srcObject) return;
    try {
      await this.audio.play();
      this.patch({ audioEnabled: true });
    } catch { this.patch({ audioEnabled: false }); }
  };

  private async measureBitrate() {
    const connection = this.connection;
    if (!connection?.open || !this.state.streamReady || this.measuringBitrate || this.state.playback.phase !== 'playing') return;
    this.measuringBitrate = true;
    try {
      const stats = await connection.peerConnection.getStats();
      if (this.connection !== connection) return;
      let bytes = 0;
      let timestamp = 0;
      let found = false;
      stats.forEach((report) => {
        const inbound = report as RTCInboundRtpStreamStats & { kind?: string; mediaType?: string };
        if (inbound.type !== 'inbound-rtp' || (inbound.kind !== 'audio' && inbound.mediaType !== 'audio') || typeof inbound.bytesReceived !== 'number') return;
        bytes += inbound.bytesReceived;
        timestamp = Math.max(timestamp, inbound.timestamp);
        found = true;
      });
      if (!found) return;
      const sample = { bytes, timestamp };
      const bitrateKbps = this.bitrateSample ? measuredBitrateKbps(this.bitrateSample, sample) : null;
      this.bitrateSample = sample;
      if (bitrateKbps !== null && this.state.playback.phase === 'playing') this.patch({ bitrateKbps });
    } catch {
      // Stats are optional and can be unavailable while WebRTC is reconnecting.
    } finally {
      this.measuringBitrate = false;
    }
  }

  command = (command: Command) => {
    if (!this.connection?.open || this.state.status !== 'connected') return;
    if (command.type !== 'pause') void this.enableAudio();
    this.connection.send(command);
  };

  adjustVolume = (change: number) => {
    const target = Math.max(0, Math.min(1, Math.round((this.volumeTarget + change) * 20) / 20));
    this.volumeTarget = target;
    this.patch({ volume: target });
    cancelAnimationFrame(this.volumeFrame);
    const ramp = () => {
      const difference = this.volumeTarget - this.audio.volume;
      if (Math.abs(difference) < 0.005) {
        this.audio.volume = this.volumeTarget;
        this.volumeFrame = 0;
        return;
      }
      this.audio.volume = Math.max(0, Math.min(1, this.audio.volume + difference * 0.28));
      this.volumeFrame = requestAnimationFrame(ramp);
    };
    this.volumeFrame = requestAnimationFrame(ramp);
  };

  private updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const track = this.state.tracks.find((track) => track.id === this.state.playback.trackId);
    navigator.mediaSession.metadata = track ? new MediaMetadata({ title: track.name, artist: 'Airside', album: this.state.folder }) : null;
    navigator.mediaSession.playbackState = this.state.playback.phase === 'playing' ? 'playing' : 'paused';
    for (const [action, type] of [['play', 'play'], ['pause', 'pause'], ['nexttrack', 'next'], ['previoustrack', 'previous']] as const) {
      try { navigator.mediaSession.setActionHandler(action, () => this.command({ type })); } catch { /* Optional browser feature. */ }
    }
  }

  private lost(message?: string) {
    const error = message ?? (this.receivedError ? this.state.error : 'Desktop disconnected. Keep its tab open and tap Reconnect.');
    this.cleanup();
    ++this.generation;
    this.bitrateSample = null;
    this.patch({ status: 'disconnected', streamReady: false, audioEnabled: false, bitrateKbps: null, error, playback: { ...this.state.playback, phase: 'paused' } });
  }

  private cleanup() {
    clearInterval(this.timer);
    clearInterval(this.playbackTimer);
    clearTimeout(this.signalingReconnectTimer);
    clearTimeout(this.mediaRetryTimer);
    const connection = this.connection;
    this.connection = null;
    // Remove listeners before closing so deliberate cleanup cannot trigger lost().
    connection?.removeAllListeners();
    this.peer?.removeAllListeners();
    connection?.close();
    this.peer?.destroy();
    this.peer = null;
    this.audio.pause();
    this.audio.srcObject = null;
  }

  destroy() {
    ++this.generation;
    cancelAnimationFrame(this.volumeFrame);
    this.cleanup();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      for (const action of ['play', 'pause', 'nexttrack', 'previoustrack'] as const) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* Optional. */ }
      }
    }
  }
}
