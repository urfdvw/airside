import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import type LibAVTypes from '@libav.js/types';
import { decodeWithLibAV } from './fallback-decode.ts';
import { audioExtensions } from './library.ts';

const libavDir = new URL('../../public/libav/', import.meta.url);
const sample = (name: string) => new Blob([readFileSync(new URL(`../../samples/${name}`, import.meta.url))]);

describe('fallback decoder', () => {
  let libav: LibAVTypes.LibAV;
  before(async () => {
    const module = await import(new URL('libav-6.10.9.0-airside.mjs', libavDir).href) as { default: LibAVTypes.LibAVWrapper };
    libav = await module.default.LibAV({ noworker: true, nothreads: true, base: libavDir.pathname });
  });

  const cases: [string, number, boolean][] = [
    ['tone-alac.m4a', 5, true],
    ['tone.ape', 5, true],
    ['tone.wv', 5, true],
    ['silence-44-s.tak', 3.685, false],
    ['tone-wmav2.wma', 4.97, true],
    ['tone-dsd64.dsf', 2, true],
    ['tone-dsd64.dff', 2, true],
  ];
  for (const [name, seconds, audible] of cases) {
    it(`decodes ${name} to 48 kHz planar stereo`, async () => {
      const pcm = await decodeWithLibAV(libav, sample(name), 48000);
      assert.equal(pcm.sampleRate, 48000);
      assert.equal(pcm.channels.length, 2);
      assert.ok(Math.abs(pcm.channels[0].length / 48000 - seconds) < 0.02, `duration ${pcm.channels[0].length / 48000}`);
      const peak = pcm.channels.reduce((max, channel) => channel.reduce((m, v) => Math.max(m, Math.abs(v)), max), 0);
      if (audible) assert.ok(peak > 0.1 && peak <= 1, `peak ${peak}`);
    });
  }

  it('rejects data that is not audio', async () => {
    await assert.rejects(decodeWithLibAV(libav, new Blob(['not audio']), 48000));
  });
});

describe('library extensions', () => {
  it('includes the fallback formats', () => {
    for (const extension of ['m4a', 'caf', 'ape', 'wv', 'tak', 'wma', 'dsf', 'dff']) assert.ok(audioExtensions.has(extension), extension);
  });
});
