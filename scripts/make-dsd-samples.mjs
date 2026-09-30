#!/usr/bin/env node
// Writes short DSD64 test tones (DSF and DSDIFF/DFF) for exercising the fallback decoder.
// Usage: node scripts/make-dsd-samples.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'samples';
const rate = 2_822_400; // DSD64
const seconds = 2;
const frames = rate * seconds;
const channels = [
  { freqs: [440, 660], gain: 0.25 },
  { freqs: [554.37, 880], gain: 0.25 },
];

// Second-order sigma-delta modulator; returns one bit per frame (1 = +1, 0 = -1).
function modulate({ freqs, gain }) {
  const bits = new Uint8Array(frames);
  let i1 = 0, i2 = 0, y = 0;
  for (let n = 0; n < frames; n++) {
    const t = n / rate;
    const fade = Math.min(1, t / 0.05, (seconds - t) / 0.05);
    let x = 0;
    for (const f of freqs) x += Math.sin(2 * Math.PI * f * t);
    x *= gain * fade / freqs.length;
    i1 += x - y;
    i2 += i1 - y;
    const bit = i2 >= 0 ? 1 : 0;
    y = bit ? 1 : -1;
    bits[n] = bit;
  }
  return bits;
}

function pack(bits, lsbFirst) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let n = 0; n < bits.length; n++) {
    if (!bits[n]) continue;
    const shift = lsbFirst ? n % 8 : 7 - (n % 8);
    bytes[n >> 3] |= 1 << shift;
  }
  return bytes;
}

const streams = channels.map(modulate);

function dsf() {
  const block = 4096;
  const perChannel = pack(streams[0], true).length;
  const blocks = Math.ceil(perChannel / block);
  const dataSize = blocks * block * streams.length;
  const lsb = streams.map((bits) => pack(bits, true));
  const buffer = Buffer.alloc(28 + 52 + 12 + dataSize);
  let o = 0;
  buffer.write('DSD ', o); buffer.writeBigUInt64LE(28n, o + 4); buffer.writeBigUInt64LE(BigInt(buffer.length), o + 12); buffer.writeBigUInt64LE(0n, o + 20); o += 28;
  buffer.write('fmt ', o); buffer.writeBigUInt64LE(52n, o + 4);
  buffer.writeUInt32LE(1, o + 12); // format version
  buffer.writeUInt32LE(0, o + 16); // DSD raw
  buffer.writeUInt32LE(2, o + 20); // channel type: stereo
  buffer.writeUInt32LE(streams.length, o + 24);
  buffer.writeUInt32LE(rate, o + 28);
  buffer.writeUInt32LE(1, o + 32); // bits per sample: LSB first
  buffer.writeBigUInt64LE(BigInt(frames), o + 36);
  buffer.writeUInt32LE(block, o + 44);
  o += 52;
  buffer.write('data', o); buffer.writeBigUInt64LE(BigInt(12 + dataSize), o + 4); o += 12;
  for (let b = 0; b < blocks; b++) {
    for (const bytes of lsb) {
      buffer.set(bytes.subarray(b * block, (b + 1) * block), o);
      o += block;
    }
  }
  return buffer;
}

function chunk(id, body) {
  const head = Buffer.alloc(12);
  head.write(id, 0); head.writeBigUInt64BE(BigInt(body.length), 4);
  return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function dff() {
  const msb = streams.map((bits) => pack(bits, false));
  const data = Buffer.alloc(msb[0].length * msb.length);
  for (let i = 0; i < msb[0].length; i++) for (let c = 0; c < msb.length; c++) data[i * msb.length + c] = msb[c][i];
  const fs = Buffer.alloc(4); fs.writeUInt32BE(rate);
  const chnl = Buffer.alloc(2 + 4 * msb.length); chnl.writeUInt16BE(msb.length); chnl.write('SLFT', 2); chnl.write('SRGT', 6);
  const cmpr = Buffer.concat([Buffer.from('DSD '), Buffer.from([14]), Buffer.from('not compressed'), Buffer.alloc(1)]);
  const prop = chunk('PROP', Buffer.concat([Buffer.from('SND '), chunk('FS  ', fs), chunk('CHNL', chnl), chunk('CMPR', cmpr)]));
  const version = Buffer.alloc(4); version.writeUInt32BE(0x01050000);
  return chunk('FRM8', Buffer.concat([Buffer.from('DSD '), chunk('FVER', version), prop, chunk('DSD ', data)]));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'tone-dsd64.dsf'), dsf());
writeFileSync(join(outDir, 'tone-dsd64.dff'), dff());
console.log(`Wrote DSF and DFF samples to ${outDir}`);
