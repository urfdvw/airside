import Peer, { type DataConnection, type MediaConnection } from 'peerjs';
import { AudioEngine } from './audio';
import { publicTrack, scanFolder, type LocalTrack } from './library';
import { AUDIO_BITRATE, PROTOCOL_VERSION, createToken, emptyPlayback, errorMessage, isCommand, isPlayback, isRecord, isTrack, stereoOpusSdp, type Command, type HostMessage, type Playback, type Track } from './protocol';

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

export interface HostState {
  peerId: string;
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
  private call: MediaConnection | null = null;
  private localTracks: LocalTrack[] = [];
  private scan: AbortController | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private signalTimer?: ReturnType<typeof setTimeout>;
  private lastPong = 0;
  private lastPing = 0;
  private engine: AudioEngine;
  private disposed = false;

  constructor() {
    super({ peerId: '', token: createToken(), signaling: 'connecting', connected: false, streaming: false, audioReady: false, scanning: false, scanCount: 0, skipped: 0, folder: '', tracks: [], playback: { ...emptyPlayback }, error: null, quality: null });
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
    const peer = new Peer();
    this.peer = peer;
    clearTimeout(this.signalTimer);
    this.signalTimer = setTimeout(() => {
      if (this.state.signaling === 'connecting') this.patch({ signaling: 'offline', error: 'PeerJS is taking too long to connect. Check your internet connection and retry.' });
    }, 15000);
    peer.on('open', (peerId) => {
      clearTimeout(this.signalTimer);
      this.patch({ peerId, signaling: 'online', error: null });
    });
    peer.on('connection', (connection) => this.accept(connection));
    peer.on('call', (call) => call.close());
    peer.on('disconnected', () => this.patch({ signaling: 'offline' }));
    peer.on('error', (error) => this.patch({ error: peerError(error), signaling: peer.disconnected || peer.destroyed ? 'offline' : this.state.signaling }));
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

  private ensureMedia() {
    if (!this.peer || !this.connection?.open || !this.engine.stream || this.call) return;
    const call = this.peer.call(this.connection.peer, this.engine.stream, {
      metadata: { token: this.state.token, version: PROTOCOL_VERSION }, sdpTransform: stereoOpusSdp,
    });
    this.call = call;
    const pc = call.peerConnection;
    let configured = false;
    pc.addEventListener('connectionstatechange', () => {
      if (this.call !== call) return;
      if (pc.connectionState === 'connected') {
        this.patch({ streaming: true });
        if (!configured) { configured = true; void this.configureAudio(pc); }
      } else if (['failed', 'closed'].includes(pc.connectionState)) {
        this.closeMedia();
        this.engine.pause();
        this.send({ type: 'error', message: 'Audio connection lost. Tap Reconnect to try again.' });
      } else if (pc.connectionState === 'disconnected') {
        this.patch({ streaming: false });
      }
    });
    call.on('error', (error) => {
      if (this.call !== call) return;
      this.closeMedia();
      this.engine.pause();
      this.patch({ error: peerError(error) });
      this.send({ type: 'error', message: 'Audio connection failed. Tap Reconnect to try again.' });
    });
    call.on('close', () => { if (this.call === call) { this.closeMedia(); this.engine.pause(); } });
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
      if (this.call?.peerConnection === pc) this.patch({ quality: stereo ? 'Opus · stereo negotiated' : 'Stereo was not confirmed by this browser.' });
    } catch {
      if (this.call?.peerConnection === pc) this.patch({ quality: 'This browser could not enforce the 128 kbps cap.' });
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
    const call = this.call;
    this.call = null;
    call?.close();
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
  error: string | null;
}

export class PlayerSession extends Store<PlayerState> {
  private peer: Peer | null = null;
  private connection: DataConnection | null = null;
  private call: MediaConnection | null = null;
  private audio = new Audio();
  private timer?: ReturnType<typeof setInterval>;
  private lastMessage = 0;
  private pendingTracks: Track[] = [];
  private receivedError = false;
  private generation = 0;

  constructor(private hostId: string, private token: string) {
    super({ status: 'connecting', tracks: [], folder: '', loadingLibrary: false, playback: { ...emptyPlayback }, streamReady: false, audioEnabled: false, error: null });
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
    this.patch({ status: 'connecting', error: null, audioEnabled: false, streamReady: false });
    this.lastMessage = Date.now();
    const peer = new Peer();
    this.peer = peer;
    peer.on('open', () => {
      if (generation !== this.generation) return;
      const connection = peer.connect(this.hostId, { reliable: true, metadata: { token: this.token, version: PROTOCOL_VERSION } });
      this.connection = connection;
      connection.on('data', (data: unknown) => { if (generation === this.generation) this.receive(data); });
      connection.on('close', () => { if (generation === this.generation) this.lost(); });
      connection.on('error', (error) => { if (generation === this.generation) this.lost(peerError(error)); });
    });
    peer.on('call', (call) => {
      const meta: unknown = call.metadata;
      if (generation !== this.generation || call.peer !== this.hostId || !isRecord(meta) || meta.token !== this.token || meta.version !== PROTOCOL_VERSION) { call.close(); return; }
      this.call?.close();
      this.call = call;
      call.on('stream', (stream) => {
        if (this.call !== call) return;
        this.audio.srcObject = stream;
        this.patch({ streamReady: true });
        void this.enableAudio();
      });
      call.on('close', () => {
        if (this.call === call) { this.call = null; this.patch({ streamReady: false, audioEnabled: false }); }
      });
      call.on('error', () => { if (this.call === call) this.patch({ error: 'Audio could not connect. Tap Reconnect to try again.', streamReady: false }); });
      call.answer(undefined, { sdpTransform: stereoOpusSdp });
    });
    peer.on('error', (error) => { if (generation === this.generation) this.lost(peerError(error)); });
    peer.on('disconnected', () => {
      // Existing WebRTC connections survive signaling interruptions.
      if (generation === this.generation && this.state.status !== 'connected') this.lost();
    });
    this.timer = setInterval(() => {
      if (Date.now() - this.lastMessage > 20000) this.lost(this.state.status === 'connecting'
        ? 'Connection timed out. Check that the desktop is online. Some networks block direct connections.'
        : 'Desktop connection lost. Keep its tab open and tap Reconnect.');
    }, 2000);
  };

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
    } else if (data.type === 'state' && isPlayback(data.playback)) {
      this.patch({ playback: data.playback });
      this.updateMediaSession();
    } else if (data.type === 'error' && typeof data.message === 'string') {
      this.receivedError = true;
      this.patch({ error: data.message });
    } else if (data.type === 'ping') {
      this.connection?.send({ type: 'pong' });
    }
  }

  enableAudio = async () => {
    if (!this.audio.srcObject) return;
    try {
      await this.audio.play();
      this.patch({ audioEnabled: true });
    } catch { this.patch({ audioEnabled: false }); }
  };

  command = (command: Command) => {
    if (!this.connection?.open || this.state.status !== 'connected') return;
    if (command.type !== 'pause') void this.enableAudio();
    this.connection.send(command);
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
    this.patch({ status: 'disconnected', streamReady: false, audioEnabled: false, error, playback: { ...this.state.playback, phase: 'paused' } });
  }

  private cleanup() {
    clearInterval(this.timer);
    const connection = this.connection;
    const call = this.call;
    this.connection = null;
    this.call = null;
    // Remove listeners before closing so deliberate cleanup cannot trigger lost().
    connection?.removeAllListeners();
    call?.removeAllListeners();
    this.peer?.removeAllListeners();
    connection?.close();
    call?.close();
    this.peer?.destroy();
    this.peer = null;
    this.audio.pause();
    this.audio.srcObject = null;
  }

  destroy() {
    ++this.generation;
    this.cleanup();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      for (const action of ['play', 'pause', 'nexttrack', 'previoustrack'] as const) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* Optional. */ }
      }
    }
  }
}
