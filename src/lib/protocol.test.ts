import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createPin, formatTime, hostPeerId, isAudioBatch, isCommand, isPin, isPlayback, isPlayerMessage, isStreamStart, joinPackets, loginUrl, normalizePin, opusPreSkip, pairingFromUrl, pinPlayerUrl, playerUrl, shuffleTracks, sortTracksByName, splitPackets } from './protocol.ts';

afterEach(() => mock.restoreAll());

describe('pairing protocol', () => {
  it('builds a hash player URL containing the peer and token', () => {
    assert.equal(playerUrl('http://192.168.1.20:5173/app/', 'peer 123', 'secret&token'),
      'http://192.168.1.20:5173/app/#/player?peer=peer+123&token=secret%26token');
  });

  it('rejects non-web URL schemes', () => {
    assert.throws(() => playerUrl('javascript:alert(1)', 'peer', 'token'));
  });

  it('creates and normalizes four-letter pairing PINs', () => {
    mock.method(crypto, 'getRandomValues', (bytes: Uint8Array) => bytes.fill(0));
    assert.equal(createPin(), 'AAAA');
    assert.equal(normalizePin('a-b 1cD!'), 'ABCD');
    assert.equal(isPin('ABCD'), true);
    assert.equal(isPin('AIOZ'), false);
    assert.equal(hostPeerId('ABCD'), 'airside-abcd');
  });

  it('builds PIN, login, and scannable pairing URLs', () => {
    const url = pinPlayerUrl('https://urfdvw.github.io/airside/', 'ABCD');
    assert.equal(url, 'https://urfdvw.github.io/airside/#/player?peer=airside-abcd&token=ABCD');
    assert.deepEqual(pairingFromUrl(url), { peer: 'airside-abcd', token: 'ABCD' });
    assert.equal(pairingFromUrl('https://example.com/#/player?peer=other&token=ABCD'), null);
    assert.equal(pairingFromUrl('https://urfdvw.github.io/airside/#/login'), null);
    assert.equal(loginUrl('https://urfdvw.github.io/airside/'), 'https://urfdvw.github.io/airside/#/login');
  });

  it('accepts only known commands', () => {
    assert.equal(isCommand({ type: 'play', trackId: 'song.mp3' }), true);
    assert.equal(isCommand({ type: 'seek', position: 42.5 }), true);
    assert.equal(isCommand({ type: 'shuffle', enabled: true }), true);
    assert.equal(isCommand({ type: 'shuffle', enabled: 'yes' }), false);
    assert.equal(isCommand({ type: 'seek', position: -1 }), false);
    assert.equal(isCommand({ type: 'delete', trackId: 'song.mp3' }), false);
    assert.equal(isCommand({ type: 'play', trackId: 4 }), false);
  });

  it('rejects malformed playback state', () => {
    assert.equal(isPlayback({ trackId: null, phase: 'paused', position: 0, duration: 1, error: null }), true);
    assert.equal(isPlayback({ trackId: null, phase: 'paused', position: -1, duration: 1, error: null }), false);
    assert.equal(isPlayback({ trackId: null, phase: 'deleted', position: 0, duration: 1, error: null }), false);
  });
});

describe('playlist ordering', () => {
  const tracks = [
    { id: '10', name: 'Track 10.mp3', path: 'B/Track 10.mp3' },
    { id: '2', name: 'track 2.mp3', path: 'A/track 2.mp3' },
    { id: '1', name: 'Track 1.mp3', path: 'C/Track 1.mp3' },
  ];

  it('sorts naturally by filename without mutating the source', () => {
    assert.deepEqual(sortTracksByName(tracks).map((track) => track.id), ['1', '2', '10']);
    assert.deepEqual(tracks.map((track) => track.id), ['10', '2', '1']);
  });

  it('produces a new non-original shuffle and avoids the previous order', () => {
    const sorted = sortTracksByName(tracks);
    const first = shuffleTracks(sorted, [], () => 0.99);
    const second = shuffleTracks(sorted, first.map((track) => track.id), () => 0.99);
    assert.notDeepEqual(first.map((track) => track.id), sorted.map((track) => track.id));
    assert.notDeepEqual(second.map((track) => track.id), first.map((track) => track.id));
    assert.deepEqual(new Set(second.map((track) => track.id)), new Set(sorted.map((track) => track.id)));
  });
});

describe('audio stream messages', () => {
  it('round-trips Opus packets through a batch', () => {
    const packets = [new Uint8Array([1, 2, 3]), new Uint8Array([]), new Uint8Array([4])];
    const batch = { type: 'audio', streamId: 2, ...joinPackets(packets) };
    assert.equal(isAudioBatch(batch), true);
    assert.deepEqual(splitPackets(batch).map((packet) => [...packet]), [[1, 2, 3], [], [4]]);
  });

  it('rejects batches whose sizes do not match the data', () => {
    assert.equal(isAudioBatch({ type: 'audio', streamId: 1, data: new ArrayBuffer(4), sizes: [3] }), false);
    assert.equal(isAudioBatch({ type: 'audio', streamId: 1, data: [1, 2], sizes: [2] }), false);
  });

  it('validates stream starts and player messages', () => {
    assert.equal(isStreamStart({ type: 'stream-start', streamId: 1, trackId: 'a.flac', start: 12.5, frames: 48_000, preSkip: 312 }), true);
    assert.equal(isStreamStart({ type: 'stream-start', streamId: 1, trackId: 'a.flac', start: -1, frames: 48_000, preSkip: 312 }), false);
    assert.equal(isPlayerMessage({ type: 'progress', streamId: 3, position: 1.5, buffered: 20 }), true);
    assert.equal(isPlayerMessage({ type: 'progress', streamId: 3, position: Number.NaN, buffered: 20 }), false);
    assert.equal(isPlayerMessage({ type: 'ended', streamId: 3 }), true);
    assert.equal(isPlayerMessage({ type: 'media-answer', sdp: '' }), false);
  });

  it('reads the pre-skip from an OpusHead header', () => {
    const head = new Uint8Array([79, 112, 117, 115, 72, 101, 97, 100, 1, 2, 56, 1, 128, 187, 0, 0, 0, 0, 0]);
    assert.equal(opusPreSkip(head), 312);
    assert.equal(opusPreSkip(new Uint8Array(4), 100), 100);
    assert.equal(opusPreSkip(undefined), 312);
  });
});

describe('formatTime', () => {
  it('formats player timestamps', () => assert.equal(formatTime(125.9), '2:05'));
});
