import type LibAVTypes from '@libav.js/types';

type LibAV = LibAVTypes.LibAV;
type Frame = LibAVTypes.Frame;

/** Planar Float32 PCM at the requested sample rate, ready to copy into an AudioBuffer. */
export interface DecodedPcm {
  sampleRate: number;
  channels: Float32Array[];
}

let fileCounter = 0;

/**
 * Decodes the first audio stream of `file` with libav.js and resamples it (aresample, which is
 * libswresample) to planar Float32 at `sampleRate`.
 *
 * The file is exposed to libav.js as a readahead device, so it is read from the Blob in blocks
 * rather than copied into the in-memory file system first.
 *
 * MEMORY: the whole track is decoded up front. Output frames are collected and then concatenated,
 * so peak usage is roughly twice the decoded size (4 bytes × channels × samples), plus the same
 * again once the caller builds an AudioBuffer. A 10-minute stereo track at 48 kHz is ~230 MB of
 * PCM. Streaming/segmented decoding is left for later.
 */
export async function decodeWithLibAV(libav: LibAV, file: Blob, sampleRate: number): Promise<DecodedPcm> {
  const name = `input-${++fileCounter}`;
  let fmtCtx = 0;
  let codecCtx = 0, pkt = 0, frame = 0;
  let graph = 0, src = 0, sink = 0;
  let filterFrame = 0;
  await libav.mkreadaheadfile(name, file);
  try {
    const [ctx, streams] = await libav.ff_init_demuxer_file(name);
    fmtCtx = ctx;
    const stream = streams.find((candidate) => candidate.codec_type === libav.AVMEDIA_TYPE_AUDIO);
    if (!stream) throw new Error('No audio stream found in this file.');
    [, codecCtx, pkt, frame] = await libav.ff_init_decoder(stream.codec_id, {
      codecpar: stream.codecpar,
      time_base: [stream.time_base_num, stream.time_base_den],
    });
    if (!codecCtx) throw new Error('No decoder is available for this audio codec.');
    filterFrame = await libav.av_frame_alloc();

    const planes: Float32Array[][] = [];
    let outputChannels = 0;

    const resample = async (frames: Frame[], fin: boolean) => {
      if (!graph) {
        if (!frames.length) return;
        // Configure the resampler from the first decoded frame: some decoders only settle their
        // sample format and layout once they have seen data.
        const first = frames[0];
        const channels = first.channels ?? libav.ff_channels(first);
        const layout = first.channel_layout || libav.ff_channel_layout({ channels });
        outputChannels = channels;
        [graph, src, sink] = await libav.ff_init_filter_graph('aresample', {
          sample_rate: first.sample_rate,
          sample_fmt: first.format,
          channel_layout: layout,
        }, {
          sample_rate: sampleRate,
          sample_fmt: libav.AV_SAMPLE_FMT_FLTP,
          channel_layout: layout,
        });
      }
      const out = await libav.ff_filter_multi(src, sink, filterFrame, frames, { fin });
      for (const resampled of out) {
        if (resampled.nb_samples) planes.push(resampled.data as Float32Array[]);
      }
    };

    for (;;) {
      const [result, packets] = await libav.ff_read_frame_multi(fmtCtx, pkt, { limit: 1024 * 1024 });
      const eof = result === libav.AVERROR_EOF;
      if (!eof && result !== 0 && result !== -libav.EAGAIN) {
        throw new Error(`Could not read this file (libav error ${result}).`);
      }
      const decoded = await libav.ff_decode_multi(codecCtx, pkt, frame, packets[stream.index] ?? [], { fin: eof, ignoreErrors: true });
      await resample(decoded, eof);
      if (eof) break;
    }

    const length = planes.reduce((total, chunk) => total + chunk[0].length, 0);
    if (!length || !outputChannels) throw new Error('The file decoded to no audio.');
    const channels = Array.from({ length: outputChannels }, () => new Float32Array(length));
    let offset = 0;
    for (const chunk of planes) {
      for (let channel = 0; channel < outputChannels; channel++) channels[channel].set(chunk[channel], offset);
      offset += chunk[0].length;
    }
    return { sampleRate, channels };
  } finally {
    if (graph) await libav.avfilter_graph_free_js(graph);
    if (filterFrame) await libav.av_frame_free_js(filterFrame);
    if (codecCtx) await libav.ff_free_decoder(codecCtx, pkt, frame);
    if (fmtCtx) await libav.avformat_close_input_js(fmtCtx);
    await libav.unlinkreadaheadfile(name);
  }
}
