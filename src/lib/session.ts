import Peer, { type DataConnection } from 'peerjs';
import { PlaybackEngine } from './audio';
import { publicTrack, scanFolder, type LocalTrack } from './library';
import { PROTOCOL_VERSION, createPin, emptyPlayback, errorMessage, hostPeerId, isAudioBatch, isCommand, isPlayback, isPlayerMessage, isRecord, isStreamStart, isTrack, shuffleTracks, sortTracksByName, type Command, type HostMessage, type Playback, type PlayerMessage, type Track } from './protocol';
import { StreamPlayer, type StreamStatus } from './stream-player';
import { StreamSender, isStreamingSupported } from './stream-sender';

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
  /** Seconds of audio buffered on the phone, from its latest report. */
  phoneBuffer: number | null;
  scanning: boolean;
  scanCount: number;
  skipped: number;
  folder: string;
  tracks: Track[];
  shuffle: boolean;
  playback: Playback;
  error: string | null;
}

export class HostSession extends Store<HostState> {
  private peer: Peer | null = null;
  private connection: DataConnection | null = null;
  private sender: StreamSender;
  private localTracks: LocalTrack[] = [];
  private lastShuffleOrder: string[] = [];
  private scan: AbortController | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private signalTimer?: ReturnType<typeof setTimeout>;
  private peerReconnectTimer?: ReturnType<typeof setTimeout>;
  private lastPong = 0;
  private lastPing = 0;
  private engine: PlaybackEngine;
  private disposed = false;

  constructor() {
    const pin = createPin();
    super({ peerId: '', pin, token: pin, signaling: 'connecting', connected: false, phoneBuffer: null, scanning: false, scanCount: 0, skipped: 0, folder: '', tracks: [], shuffle: false, playback: { ...emptyPlayback }, error: null });
    this.sender = new StreamSender(
      (message) => this.send(message),
      () => {
        const connection = this.connection;
        if (!connection?.open || !connection.dataChannel) return null;
        return { channel: connection.dataChannel, queued: (connection as DataConnection & { bufferSize?: number }).bufferSize ?? 0 };
      },
      (message) => this.engine.fail(message),
    );
    this.engine = new PlaybackEngine((playback) => {
      this.patch({ playback });
      this.send({ type: 'state', playback });
    }, (request) => {
      if (request) this.sender.start(request);
      else this.sender.stop();
    }, () => this.move(1, false));
    void isStreamingSupported().then((supported) => {
      if (!supported && !this.disposed) this.patch({ error: 'This browser cannot encode Opus audio. Use a current desktop Chrome or Edge.' });
    });
  }

  start() {
    this.disposed = false;
    this.openPeer();
    this.timer = setInterval(() => {
      const playback = this.engine.snapshot;
      this.patch({ playback });
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
      if (isPlayerMessage(data)) this.receive(data);
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
    this.send({ type: 'shuffle', enabled: this.state.shuffle });
  }

  private receive(message: PlayerMessage) {
    if (message.type === 'pong') {
      this.lastPong = Date.now();
    } else if (message.type === 'ready') {
      // A (re)connected phone has no audio buffered; stream again from the current position.
      this.engine.restartStream();
    } else if (message.type === 'progress') {
      this.engine.report(message.streamId, message.position);
      this.sender.progress(message.streamId, message.position);
      if (message.streamId === this.sender.streamId) this.patch({ phoneBuffer: message.buffered });
    } else if (message.type === 'ended') {
      this.engine.ended(message.streamId);
    }
  }

  openFolder = async () => {
    if (!window.isSecureContext || !('showDirectoryPicker' in window)) {
      this.patch({ error: 'Folder access needs desktop Chrome or Edge on HTTPS or localhost.' });
      return;
    }
    this.patch({ scanning: true, scanCount: 0, error: null });
    try {
      const directory = await window.showDirectoryPicker({ mode: 'read', id: 'airside-library', startIn: 'music' });
      if (this.disposed) return;
      this.scan?.abort();
      const scan = new AbortController();
      this.scan = scan;
      const { tracks, skipped } = await scanFolder(directory, scan.signal, (scanCount) => this.patch({ scanCount }));
      if (this.disposed || scan.signal.aborted) return;
      this.engine.reset();
      this.lastShuffleOrder = [];
      this.localTracks = this.state.shuffle ? shuffleTracks(tracks) : sortTracksByName(tracks);
      if (this.state.shuffle) this.lastShuffleOrder = this.localTracks.map((track) => track.id);
      this.patch({ folder: directory.name, tracks: this.localTracks.map(publicTrack), skipped, error: null });
      this.sendLibrary();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.patch({ error: errorMessage(error) });
    } finally { if (!this.disposed) this.patch({ scanning: false }); }
  };

  command = (command: Command) => {
    if (command.type === 'pause') { this.engine.pause(); return; }
    if (command.type === 'next') { this.move(1); return; }
    if (command.type === 'previous') { this.move(-1); return; }
    if (command.type === 'seek') { this.engine.seek(command.position); return; }
    if (command.type === 'shuffle') { this.setShuffle(command.enabled); return; }
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

  private setShuffle(enabled: boolean) {
    if (enabled === this.state.shuffle) return;
    const sorted = sortTracksByName(this.localTracks);
    this.localTracks = enabled ? shuffleTracks(sorted, this.lastShuffleOrder) : sorted;
    if (enabled) this.lastShuffleOrder = this.localTracks.map((track) => track.id);
    this.patch({ shuffle: enabled, tracks: this.localTracks.map(publicTrack) });
    this.sendLibrary();
  }

  private move(direction: number, wrap = true) {
    if (!this.localTracks.length) return;
    const current = this.localTracks.findIndex((track) => track.id === this.engine.snapshot.trackId);
    let next = current < 0 ? 0 : current + direction;
    if (!wrap && next >= this.localTracks.length) return;
    next = (next + this.localTracks.length) % this.localTracks.length;
    void this.engine.select(this.localTracks[next]);
  }

  disconnect = () => {
    const connection = this.connection;
    this.connection = null;
    connection?.close();
    this.engine.pause();
    this.patch({ connected: false, phoneBuffer: null });
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
    this.sender.destroy();
  }
}

export interface PlayerState {
  status: 'connecting' | 'connected' | 'disconnected';
  tracks: Track[];
  shuffle: boolean;
  folder: string;
  loadingLibrary: boolean;
  playback: Playback;
  /** The audio pipeline exists, so a tap can start sound. */
  streamReady: boolean;
  audioEnabled: boolean;
  /** Seconds of audio buffered ahead of playback. */
  buffered: number | null;
  /** Playback is held until the network delivers enough audio. */
  buffering: boolean;
  volume: number;
  error: string | null;
}

export class PlayerSession extends Store<PlayerState> {
  private peer: Peer | null = null;
  private connection: DataConnection | null = null;
  private audio = new Audio();
  private player: StreamPlayer;
  private timer?: ReturnType<typeof setInterval>;
  private lastMessage = 0;
  private pendingTracks: Track[] = [];
  private receivedError = false;
  private generation = 0;
  private volumeFrame = 0;
  private volumeTarget = 1;
  private signalingReconnectTimer?: ReturnType<typeof setTimeout>;
  private lastProgress = 0;
  private endedStream = -1;
  private local: StreamStatus | null = null;

  constructor(private hostId: string, private token: string) {
    super({ status: 'connecting', tracks: [], folder: '', loadingLibrary: false, shuffle: false, playback: { ...emptyPlayback }, streamReady: false, audioEnabled: false, buffered: null, buffering: false, volume: 1, error: null });
    this.audio.setAttribute('playsinline', '');
    this.audio.autoplay = true;
    this.player = new StreamPlayer(this.audio, (status) => this.streamStatus(status), (error) => this.patch({ error }));
    // Lets iOS keep playing with the screen locked or the ringer switched off.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) try { session.type = 'playback'; } catch { /* Optional. */ }
  }

  start = () => {
    this.cleanup();
    const generation = ++this.generation;
    this.receivedError = false;
    if (!this.hostId || !this.token) {
      this.patch({ status: 'disconnected', error: 'Open the player link or scan the QR code on your desktop to connect.' });
      return;
    }
    this.patch({ status: 'connecting', error: null, buffered: null, buffering: false });
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
      if (Date.now() - this.lastMessage > 20000) this.lost(this.state.status === 'connecting'
        ? 'Connection timed out. Check that the desktop is online. Some networks block direct connections.'
        : 'Desktop connection lost. Keep its tab open and tap Reconnect.');
    }, 1000);
  };

  private scheduleSignalingReconnect(peer: Peer, generation: number) {
    clearTimeout(this.signalingReconnectTimer);
    this.signalingReconnectTimer = setTimeout(() => {
      if (generation !== this.generation || this.peer !== peer || peer.destroyed || !peer.disconnected) return;
      try { peer.reconnect(); } catch { /* Keep the active WebRTC connection alive. */ }
    }, 750);
  }

  private send(message: PlayerMessage | Command) {
    if (!this.connection?.open) return;
    try { this.connection.send(message); } catch { /* The connection watchdog reports failures. */ }
  }

  /** Status of the stream the phone is actually playing, from the audio worklet. */
  private streamStatus(status: StreamStatus) {
    this.local = status;
    const playback = this.state.playback;
    const current = status.trackId === playback.trackId;
    this.patch({
      buffered: status.buffered,
      buffering: status.waiting && playback.phase === 'playing' && !status.finished,
      ...(current ? { playback: { ...playback, position: Math.min(playback.duration || Infinity, status.position) } } : {}),
    });
    const now = performance.now();
    if (now - this.lastProgress > 500) {
      this.lastProgress = now;
      this.send({ type: 'progress', streamId: status.streamId, position: status.position, buffered: status.buffered });
    }
    if (status.finished && this.endedStream !== status.streamId) {
      this.endedStream = status.streamId;
      this.send({ type: 'progress', streamId: status.streamId, position: status.position, buffered: 0 });
      this.send({ type: 'ended', streamId: status.streamId });
    }
  }

  private receive(data: unknown) {
    if (!isRecord(data)) return;
    this.lastMessage = Date.now();
    if (isAudioBatch(data)) {
      this.player.push(data);
    } else if (isStreamStart(data)) {
      this.local = null;
      this.player.start(data);
      if (!this.state.streamReady) this.patch({ streamReady: true });
    } else if (data.type === 'stream-end' && typeof data.streamId === 'number') {
      this.player.end(data.streamId);
    } else if (data.type === 'welcome' && data.version === PROTOCOL_VERSION) {
      this.patch({ status: 'connected', error: null });
      this.send({ type: 'ready' });
    } else if (data.type === 'library-start' && typeof data.folder === 'string') {
      this.pendingTracks = [];
      this.patch({ folder: data.folder, loadingLibrary: true });
    } else if (data.type === 'library-chunk' && Array.isArray(data.tracks) && data.tracks.every(isTrack)) {
      this.pendingTracks.push(...data.tracks);
    } else if (data.type === 'library-end') {
      this.patch({ tracks: this.pendingTracks, loadingLibrary: false });
    } else if (data.type === 'shuffle' && typeof data.enabled === 'boolean') {
      this.patch({ shuffle: data.enabled });
    } else if (data.type === 'state' && isPlayback(data.playback)) {
      const playback = { ...data.playback };
      const stream = this.player.currentStream;
      if (stream && playback.trackId !== stream.trackId) {
        // The desktop moved on (new track, decode error); drop audio of the old one.
        this.player.clear();
        this.local = null;
      }
      // The phone's own clock is the most accurate position for the audio it is playing.
      const local = this.local;
      if (local && this.player.currentStream?.streamId === local.streamId && local.trackId === playback.trackId) {
        playback.position = Math.min(playback.duration || Infinity, local.position);
      }
      this.player.setPlaying(playback.phase === 'playing');
      this.patch({ playback, ...(playback.phase !== 'playing' ? { buffering: false } : {}) });
      this.updateMediaSession();
    } else if (data.type === 'error' && typeof data.message === 'string') {
      this.receivedError = true;
      this.patch({ error: data.message });
    } else if (data.type === 'ping') {
      this.send({ type: 'pong' });
    }
  }

  enableAudio = async () => {
    try {
      const running = await this.player.resume();
      this.patch({ audioEnabled: running, streamReady: true });
    } catch { this.patch({ audioEnabled: false }); }
  };

  command = (command: Command) => {
    if (!this.connection?.open || this.state.status !== 'connected') return;
    if (['play', 'next', 'previous', 'seek'].includes(command.type)) void this.enableAudio();
    this.send(command);
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
    this.patch({ status: 'disconnected', buffered: null, buffering: false, error, playback: { ...this.state.playback, phase: 'paused' } });
  }

  private cleanup() {
    clearInterval(this.timer);
    clearTimeout(this.signalingReconnectTimer);
    const connection = this.connection;
    this.connection = null;
    // Remove listeners before closing so deliberate cleanup cannot trigger lost().
    connection?.removeAllListeners();
    this.peer?.removeAllListeners();
    connection?.close();
    this.peer?.destroy();
    this.peer = null;
    // Keep the audio pipeline (and the user's audio permission) for the next connection.
    this.player.setPlaying(false);
    this.player.clear();
    this.local = null;
  }

  destroy() {
    ++this.generation;
    cancelAnimationFrame(this.volumeFrame);
    this.cleanup();
    this.player.destroy();
    this.audio.pause();
    this.audio.srcObject = null;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      for (const action of ['play', 'pause', 'nexttrack', 'previoustrack'] as const) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* Optional. */ }
      }
    }
  }
}
