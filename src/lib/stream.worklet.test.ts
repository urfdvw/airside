import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { WorkletCommand, WorkletStatus } from './stream.worklet.ts';

// Minimal AudioWorkletGlobalScope so the processor can run in Node.
type Processor = { port: { onmessage: (event: { data: WorkletCommand }) => void }; process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };
let Processor: new () => Processor;
const reports: WorkletStatus[] = [];
const scope = globalThis as Record<string, unknown>;
scope.sampleRate = 100;
scope.AudioWorkletProcessor = class { port = { onmessage: null as unknown, postMessage: (message: WorkletStatus) => reports.push(message) }; };
scope.registerProcessor = (_name: string, processor: new () => Processor) => { Processor = processor; };

function render(processor: Processor, quanta = 1, size = 10) {
  const left: number[] = [];
  for (let i = 0; i < quanta; i++) {
    const output = [new Float32Array(size), new Float32Array(size)];
    processor.process([], [output]);
    left.push(...output[0]);
  }
  return left;
}
const send = (processor: Processor, data: WorkletCommand) => processor.port.onmessage({ data });
const ramp = (from: number, count: number) => Float32Array.from({ length: count }, (_, i) => from + i);

describe('stream worklet', () => {
  before(async () => { await import('./stream.worklet.ts'); });
  let processor: Processor;
  beforeEach(() => {
    reports.length = 0;
    processor = new Processor();
    send(processor, { type: 'thresholds', start: 20, rebuffer: 30 });
    send(processor, { type: 'reset', streamId: 1, frames: 50, preSkip: 5 });
    send(processor, { type: 'playing', playing: true });
  });

  it('drops the pre-skip and waits for the start threshold', () => {
    send(processor, { type: 'pcm', streamId: 1, channels: [ramp(0, 15), ramp(0, 15)] });
    assert.deepEqual(render(processor), new Array(10).fill(0)); // only 10 frames buffered < 20
    send(processor, { type: 'pcm', streamId: 1, channels: [ramp(15, 15), ramp(15, 15)] });
    assert.deepEqual(render(processor, 2), [...ramp(5, 20)]);
  });

  it('holds playback when it runs dry instead of skipping audio', () => {
    send(processor, { type: 'reset', streamId: 1, frames: 100, preSkip: 5 });
    send(processor, { type: 'pcm', streamId: 1, channels: [ramp(0, 30), ramp(0, 30)] });
    const first = render(processor, 3); // 25 frames available, then underrun
    assert.deepEqual(first.slice(0, 25), [...ramp(5, 25)]);
    assert.equal(reports.at(-1)?.waiting, true);
    send(processor, { type: 'pcm', streamId: 1, channels: [ramp(30, 25), ramp(30, 25)] });
    assert.deepEqual(render(processor), new Array(10).fill(0)); // 25 frames < rebuffer threshold of 30
    send(processor, { type: 'end', streamId: 1 });
    assert.deepEqual(render(processor, 3).slice(0, 25), [...ramp(30, 25)]); // resumes exactly where it stopped
  });

  it('stops at the declared length and reports the end', () => {
    send(processor, { type: 'pcm', streamId: 1, channels: [ramp(0, 80), ramp(0, 80)] });
    const out = render(processor, 6);
    assert.deepEqual(out.slice(0, 50), [...ramp(5, 50)]);
    assert.deepEqual(out.slice(50), new Array(10).fill(0));
    assert.equal(reports.at(-1)?.finished, true);
    assert.equal(reports.at(-1)?.played, 50);
  });

  it('ignores audio from an older stream and outputs silence while paused', () => {
    send(processor, { type: 'pcm', streamId: 0, channels: [ramp(0, 40), ramp(0, 40)] });
    assert.deepEqual(render(processor), new Array(10).fill(0));
    send(processor, { type: 'pcm', streamId: 1, channels: [ramp(0, 40), ramp(0, 40)] });
    send(processor, { type: 'playing', playing: false });
    assert.deepEqual(render(processor), new Array(10).fill(0));
    send(processor, { type: 'playing', playing: true });
    assert.deepEqual(render(processor), [...ramp(5, 10)]);
  });
});
