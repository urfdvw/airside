import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import { AlertCircle, Check, ChevronLeft, Copy, FolderOpen, Library, Link2, LoaderCircle, Music2, Pause, Play, Radio, RefreshCw, SkipBack, SkipForward, Smartphone, Unplug, Volume2, Wifi } from 'lucide-react';
import { HostSession, PlayerSession } from './lib/session';
import { AUDIO_BITRATE, formatTime, playerUrl, type Track } from './lib/protocol';

function App() {
  return window.location.hash.startsWith('#/player') ? <PlayerPage /> : <HomePage />;
}

function Brand() {
  return <a className="brand" href="#/" aria-label="Airside home"><span className="brand-mark"><Radio size={18} /></span><span>Airside</span></a>;
}

function StatusDot({ active }: { active: boolean }) {
  return <span className={`status-dot ${active ? 'active' : ''}`} aria-hidden="true" />;
}

function HomePage() {
  const session = useMemo(() => new HostSession(), []);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [baseUrl, setBaseUrl] = useState(() => `${window.location.origin}${window.location.pathname}`);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const link = useMemo(() => {
    if (!state.peerId) return { url: '', error: null };
    try { return { url: playerUrl(baseUrl, state.peerId, state.token), error: null }; }
    catch { return { url: '', error: 'Enter a valid http:// or https:// app address.' }; }
  }, [baseUrl, state.peerId, state.token]);
  const url = link.url;

  useEffect(() => { session.start(); return () => session.destroy(); }, [session]);
  useEffect(() => {
    if (!url) { setQr(''); return; }
    console.info('Player URL:', url);
    let live = true;
    QRCode.toDataURL(url, { width: 480, margin: 2, color: { dark: '#252a25', light: '#ffffff' }, errorCorrectionLevel: 'M' })
      .then((data) => { if (live) setQr(data); })
      .catch(() => { if (live) setActionError('Could not generate the QR code. Copy the player URL instead.'); });
    return () => { live = false; };
  }, [url]);

  const current = state.tracks.find((track) => track.id === state.playback.trackId);
  const copy = async () => {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { setActionError('Copy failed. Select the URL and copy it manually.'); }
  };

  return <div className="desktop-shell">
    <header className="topbar">
      <Brand />
      <div className="top-status"><StatusDot active={state.signaling === 'online'} />{state.signaling === 'connecting' ? 'Connecting to PeerJS…' : state.signaling === 'online' ? 'Ready to pair' : 'Signaling offline'}</div>
    </header>

    <main className="desktop-main">
      <section className="hero">
        <div>
          <p className="eyebrow">YOUR MUSIC, WITHIN REACH</p>
          <h1>Listen over the air.<br /><em>Keep files at home.</em></h1>
          <p className="hero-copy">Choose a music folder on this computer, then scan once to listen from your phone. Your files stay local and stream directly between your browsers.</p>
        </div>
        <div className="privacy-note"><Wifi size={18} /><span>Direct browser-to-browser audio<br /><small>{AUDIO_BITRATE / 1000} kbps stereo Opus target</small></span></div>
      </section>

      {(state.error || link.error || actionError) && <div className="notice error" role="alert"><AlertCircle size={18} /><span>{state.error || link.error || actionError}</span>{state.signaling === 'offline' && <button className="text-button" onClick={session.retry}>Retry</button>}</div>}

      <div className="workspace-grid">
        <section className="panel library-panel">
          <div className="panel-heading">
            <div><span className="step">01</span><h2>Choose your library</h2></div>
            {state.tracks.length > 0 && <span className="count">{state.tracks.length} tracks</span>}
          </div>
          {!state.tracks.length ? <button className="folder-drop" onClick={session.openFolder} disabled={state.scanning}>
            <span className="folder-icon">{state.scanning ? <LoaderCircle className="spin" size={30} /> : <FolderOpen size={30} />}</span>
            <strong>{state.scanning ? `Scanning… ${state.scanCount || ''}` : 'Open a music folder'}</strong>
            <span>{state.scanning ? 'Looking through subfolders for playable audio' : 'MP3, M4A, AAC, WAV, FLAC, OGG, Opus and WebM'}</span>
          </button> : <>
            <div className="folder-summary"><div className="folder-avatar"><FolderOpen size={22} /></div><div><strong>{state.folder}</strong><span>{state.tracks.length} audio files{state.skipped ? ` · ${state.skipped} other files skipped` : ''}</span></div><button className="secondary small" onClick={session.openFolder}>Change</button></div>
            <TrackList tracks={state.tracks} activeId={state.playback.trackId} playing={state.playback.phase === 'playing'} onSelect={(track) => session.command({ type: 'play', trackId: track.id })} />
          </>}
          <div className="desktop-audio-note"><Volume2 size={15} /><span>Desktop speakers stay silent. Audio only goes to the paired player.</span>{state.tracks.length > 0 && !state.audioReady && <button className="text-button" onClick={session.enableAudio}>Enable streaming</button>}</div>
        </section>

        <section className="panel pairing-panel">
          <div className="panel-heading"><div><span className="step">02</span><h2>Pair your phone</h2></div></div>
          <p className="panel-copy">Scan with your phone’s camera, or open the test link in another browser tab.</p>
          <div className={`qr-frame ${state.connected ? 'paired' : ''}`}>
            {state.connected ? <div className="paired-state"><span className="phone-orbit"><Smartphone size={42} /></span><h3>Phone connected</h3><p>{state.streaming ? 'Audio channel is live' : 'Preparing audio channel…'}</p></div>
              : qr ? <img src={qr} alt="QR code for the mobile player URL" /> : <div className="qr-loading"><LoaderCircle className="spin" /><span>Creating secure link…</span></div>}
          </div>
          <label className="field-label" htmlFor="base-url">App address reachable from your phone</label>
          <input id="base-url" className="base-input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
          <div className="url-box"><Link2 size={17} /><input aria-label="Player URL" value={url} readOnly /><button onClick={copy} disabled={!url} aria-label="Copy player URL">{copied ? <Check size={18} /> : <Copy size={18} />}</button></div>
          <div className="pair-actions">
            <button className="primary" onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')} disabled={!url}><Smartphone size={18} />Open test player</button>
            {state.connected && <button className="secondary" onClick={session.disconnect}><Unplug size={17} />Disconnect</button>}
          </div>
          <p className="fine-print">The pairing token is part of the link and is also logged to the browser console. PeerJS’s public service handles signaling; connection limits and availability are outside this app.</p>
        </section>
      </div>

      {(current || state.connected) && <section className="now-playing-desktop">
        <div className="disc"><Music2 size={22} /></div>
        <div className="now-meta"><span>NOW STREAMING</span><strong>{current?.name ?? 'Waiting for a track'}</strong><small>{current?.path ?? 'Choose a track on either device'}</small></div>
        <div className="desktop-controls">
          <button onClick={() => session.command({ type: 'previous' })} aria-label="Previous"><SkipBack /></button>
          <button className="play-main" onClick={() => session.command({ type: state.playback.phase === 'playing' ? 'pause' : 'play' })} aria-label={state.playback.phase === 'playing' ? 'Pause' : 'Play'}>{state.playback.phase === 'loading' ? <LoaderCircle className="spin" /> : state.playback.phase === 'playing' ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button>
          <button onClick={() => session.command({ type: 'next' })} aria-label="Next"><SkipForward /></button>
        </div>
        <div className="stream-stats"><StatusDot active={state.streaming} /><span>{state.streaming ? 'Live' : state.connected ? 'Connecting audio' : 'Phone offline'}</span><small>{state.quality ?? `${AUDIO_BITRATE / 1000} kbps stereo target`}</small></div>
      </section>}
    </main>
  </div>;
}

function TrackList({ tracks, activeId, playing, onSelect, mobile = false }: { tracks: Track[]; activeId: string | null; playing: boolean; onSelect: (track: Track) => void; mobile?: boolean }) {
  return <div className={mobile ? 'mobile-track-list' : 'track-list'} role="list">
    {tracks.map((track, index) => <button className={`track-row ${track.id === activeId ? 'selected' : ''}`} key={track.id} onClick={() => onSelect(track)} role="listitem">
      <span className="track-number">{track.id === activeId && playing ? <span className="equalizer"><i /><i /><i /></span> : String(index + 1).padStart(2, '0')}</span>
      <span className="track-copy"><strong>{track.name.replace(/\.[^.]+$/, '')}</strong><small>{track.path.includes('/') ? track.path.slice(0, track.path.lastIndexOf('/')) : track.format}</small></span>
      <span className="track-format">{track.format}</span>
      <Play className="row-play" size={17} fill="currentColor" />
    </button>)}
  </div>;
}

function PlayerPage() {
  const params = useMemo(() => new URLSearchParams(window.location.hash.split('?')[1] ?? ''), []);
  const session = useMemo(() => new PlayerSession(params.get('peer') ?? '', params.get('token') ?? ''), [params]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [tab, setTab] = useState<'library' | 'player'>('library');
  useEffect(() => { session.start(); return () => session.destroy(); }, [session]);
  useEffect(() => { if (state.playback.trackId) setTab('player'); }, [state.playback.trackId]);
  const current = state.tracks.find((track) => track.id === state.playback.trackId);
  const progress = state.playback.duration ? Math.min(100, state.playback.position / state.playback.duration * 100) : 0;

  return <div className="phone-shell">
    {state.error && <div className="mobile-error" role="alert"><AlertCircle size={18} /><span>{state.error}</span>{state.status === 'disconnected' && <button onClick={session.start}><RefreshCw size={16} />Reconnect</button>}</div>}
    {state.streamReady && !state.audioEnabled && <button className="enable-audio" onClick={session.enableAudio}><Volume2 size={19} />Tap to enable audio</button>}

    <main className="mobile-main">
      {tab === 'library' ? <section className="mobile-library">
        <div className="mobile-title"><div><h1>{state.folder || 'Music'}</h1></div><span>{state.tracks.length} tracks</span></div>
        {state.status === 'connecting' || state.loadingLibrary ? <div className="mobile-empty"><LoaderCircle className="spin" /><strong>Connecting to your desktop…</strong><span>Keep the Airside page open there.</span></div>
          : !state.tracks.length ? <div className="mobile-empty"><Library /><strong>No music yet</strong><span>Open a folder on your desktop to fill this library.</span></div>
          : <TrackList mobile tracks={state.tracks} activeId={state.playback.trackId} playing={state.playback.phase === 'playing'} onSelect={(track) => { session.command({ type: 'play', trackId: track.id }); setTab('player'); }} />}
      </section> : <section className="player-view">
        <button className="back-library" onClick={() => setTab('library')}><ChevronLeft size={20} />Library</button>
        <div className={`album-art ${state.playback.phase === 'playing' ? 'playing' : ''}`}><div className="record-rings"><div className="record-label"><Radio size={36} /></div></div></div>
        <div className="phone-track-meta"><p>{state.playback.phase === 'loading' ? 'PREPARING STREAM' : state.playback.phase === 'playing' ? `NOW PLAYING (${state.bitrateKbps === null ? 'measuring…' : `${state.bitrateKbps}kbps`})` : 'PAUSED'}</p><h1>{current?.name.replace(/\.[^.]+$/, '') ?? 'Choose a track'}</h1><span>{current?.path.includes('/') ? current.path.slice(0, current.path.lastIndexOf('/')) : state.folder || 'Airside'}</span></div>
        <div className="progress"><div className="progress-line"><span style={{ width: `${progress}%` }} /></div><div><time>{formatTime(state.playback.position)}</time><time>-{formatTime(Math.max(0, state.playback.duration - state.playback.position))}</time></div></div>
        <div className="phone-controls">
          <button onClick={() => session.command({ type: 'previous' })} disabled={!state.tracks.length} aria-label="Previous track"><SkipBack size={27} fill="currentColor" /></button>
          <button className="phone-play" onClick={() => session.command({ type: state.playback.phase === 'playing' ? 'pause' : 'play' })} disabled={!state.tracks.length || state.status !== 'connected'} aria-label={state.playback.phase === 'playing' ? 'Pause' : 'Play'}>{state.playback.phase === 'loading' ? <LoaderCircle className="spin" /> : state.playback.phase === 'playing' ? <Pause size={31} fill="currentColor" /> : <Play size={31} fill="currentColor" />}</button>
          <button onClick={() => session.command({ type: 'next' })} disabled={!state.tracks.length} aria-label="Next track"><SkipForward size={27} fill="currentColor" /></button>
        </div>
        {state.playback.error && <p className="playback-error">{state.playback.error}</p>}
      </section>}
    </main>

    {current && tab === 'library' && <button className="mini-player" onClick={() => setTab('player')}><span className="mini-art"><Music2 size={18} /></span><span><strong>{current.name.replace(/\.[^.]+$/, '')}</strong><small>{state.playback.phase}</small></span><span className="mini-play" onClick={(event) => { event.stopPropagation(); session.command({ type: state.playback.phase === 'playing' ? 'pause' : 'play' }); }}>{state.playback.phase === 'playing' ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</span></button>}
  </div>;
}

export default App;
