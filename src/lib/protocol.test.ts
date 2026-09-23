import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { AUDIO_BITRATE, createToken, formatTime, isCommand, isPlayback, measuredBitrateKbps, playerUrl, stereoOpusSdp } from './protocol.ts';

afterEach(() => mock.restoreAll());

describe('pairing protocol', () => {
  it('builds a hash player URL containing the peer and token', () => {
    assert.equal(playerUrl('http://192.168.1.20:5173/app/', 'peer 123', 'secret&token'),
      'http://192.168.1.20:5173/app/#/player?peer=peer+123&token=secret%26token');
  });

  it('rejects non-web URL schemes', () => {
    assert.throws(() => playerUrl('javascript:alert(1)', 'peer', 'token'));
  });

  it('creates a 192-bit random token', () => {
    mock.method(crypto, 'getRandomValues', (bytes: Uint8Array) => bytes.fill(0xab));
    assert.equal(createToken(), 'ab'.repeat(24));
  });

  it('accepts only known commands', () => {
    assert.equal(isCommand({ type: 'play', trackId: 'song.mp3' }), true);
    assert.equal(isCommand({ type: 'delete', trackId: 'song.mp3' }), false);
    assert.equal(isCommand({ type: 'play', trackId: 4 }), false);
  });

  it('rejects malformed playback state', () => {
    assert.equal(isPlayback({ trackId: null, phase: 'paused', position: 0, duration: 1, error: null }), true);
    assert.equal(isPlayback({ trackId: null, phase: 'paused', position: -1, duration: 1, error: null }), false);
    assert.equal(isPlayback({ trackId: null, phase: 'deleted', position: 0, duration: 1, error: null }), false);
  });
});

describe('audio negotiation', () => {
  it('adds stereo and bitrate parameters to the Opus audio payload only', () => {
    const input = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111 0',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 VP8/90000',
    ].join('\r\n');
    const result = stereoOpusSdp(input);
    assert.match(result, new RegExp(`a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=${AUDIO_BITRATE};usedtx=0`));
    assert.match(result, /a=rtpmap:96 VP8\/90000/);
  });

  it('creates an Opus fmtp line if the offer omits it', () => {
    const result = stereoOpusSdp('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n');
    assert.match(result, new RegExp(`a=fmtp:111 stereo=1;sprop-stereo=1;maxaveragebitrate=${AUDIO_BITRATE};usedtx=0`));
  });
});

describe('formatTime', () => {
  it('formats player timestamps', () => assert.equal(formatTime(125.9), '2:05'));
});

describe('measuredBitrateKbps', () => {
  it('calculates bitrate from WebRTC byte and timestamp deltas', () => {
    assert.equal(measuredBitrateKbps({ bytes: 10_000, timestamp: 1_000 }, { bytes: 26_000, timestamp: 2_000 }), 128);
  });

  it('ignores invalid or reset counters', () => {
    assert.equal(measuredBitrateKbps({ bytes: 20, timestamp: 2_000 }, { bytes: 10, timestamp: 3_000 }), null);
    assert.equal(measuredBitrateKbps({ bytes: 10, timestamp: 2_000 }, { bytes: 20, timestamp: 2_000 }), null);
  });
});
