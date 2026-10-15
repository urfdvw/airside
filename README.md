# Airside

Airside is a pure frontend app that streams music from a folder on a desktop browser to a mobile browser. The files never upload to an application server: the desktop reads and decodes them locally, and a WebRTC data channel sends the encoded audio directly to the phone, which buffers it like an online music player.

Open the app at [urfdvw.github.io/airside](https://urfdvw.github.io/airside/).

## Rabbit r1

Scan this creation QR on a Rabbit r1 to open Airside’s login page:

![Airside Rabbit r1 creation QR](docs/rabbit-r1-qr.png)

The build generates this image from the Rabbit creation JSON format used by [`rabbit-hmi-oss/creations-sdk`](https://github.com/rabbit-hmi-oss/creations-sdk). The encoded URL is `https://urfdvw.github.io/airside/#/login?r1=1`.

## Run locally

```sh
npm install
npm run dev
```

Open `http://localhost:5173` in desktop Chrome or Edge, choose a music folder, and use the four-letter PIN or generated pairing QR in another browser. The full player URL is also logged in the desktop browser console for testing.

The production pairing QR uses `https://urfdvw.github.io/airside/`. In development it uses the current local origin. The File System Access API works on `localhost` or HTTPS and currently requires a supporting desktop browser.

## How it works

- `showDirectoryPicker()` grants read-only access to a folder and its subfolders.
- The desktop decodes the selected audio file to 48 kHz PCM with Web Audio (an `OfflineAudioContext`, so no click is needed to enable audio and nothing plays on its speakers).
- If the browser cannot decode a file (or it is a format no browser decodes: `.ape`, `.wv`, `.tak`, `.wma`, `.dsf`, `.dff`), Airside falls back to a WebAssembly decoder built from [libav.js](https://github.com/Yahweasel/libav.js) (FFmpeg). It is loaded on demand in a Web Worker the first time a file needs it, so MP3, AAC, FLAC and other natively supported files never download it. The worker reads the file in blocks, decodes the first audio stream, resamples it with libswresample to planar Float32 at 48 kHz (DSD is always resampled), and hands the PCM back to build an `AudioBuffer`. Playback, seeking and progress then work exactly as for native files.
- The fallback decoder adds ALAC (`.m4a`, `.caf`), Monkey's Audio (`.ape`), WavPack (`.wv`), TAK (`.tak`), WMA 1/2, WMA Pro and WMA Lossless (`.wma`), and DSD (`.dsf`, `.dff`). It is single-threaded, because GitHub Pages cannot send the COOP/COEP headers that `SharedArrayBuffer` needs. If neither decoder can read a file, the desktop and the phone both show an error for that track.
- Every track is decoded completely into memory before it plays, for native and fallback decoding alike. Long or high-resolution tracks can therefore use hundreds of megabytes; streaming decode is not implemented yet.
- PeerJS's default public cloud service handles signaling. The app has no custom server, API, or database.
- A single reliable PeerJS data connection carries the file list, playback commands, status, and the audio itself.
- Audio is streamed like an online music player rather than as a real-time call. The desktop encodes the decoded track with WebCodecs `AudioEncoder` to 128 kbps stereo Opus (20 ms packets) and sends the packets in half-second batches as fast as the connection allows, up to 30 seconds ahead of the phone's playback position. It keeps the data channel's send queue short, so commands and status messages never wait behind much audio.
- The phone decodes the packets with a small WebAssembly Opus decoder ([opus-decoder](https://github.com/eshaz/wasm-audio-decoders), MIT; libopus, BSD), loaded only on the phone, and plays them from a buffer in an `AudioWorklet` at its own audio clock. The output goes through a `MediaStream` into an `<audio>` element so the system treats it as media playback.
- Network trouble never changes the playback speed. Playback starts after 1 second is buffered. If the buffer runs dry, the phone goes silent, shows "Buffering…", and continues from exactly where it stopped once 4 seconds have arrived. Nothing is skipped or time-stretched.
- The phone's audio clock is the playback clock: it reports its position (and buffer level) to the desktop twice a second, and reports when a track has finished so the desktop can move to the next one. Seeking or changing tracks starts a new stream from the new position; pausing just stops the phone's playback, while its buffer is kept and keeps filling.
- Shuffle reorders the authoritative playlist on both devices without interrupting the active track; turning it off restores natural filename order.
- A random four-letter PIN determines the temporary PeerJS host ID and authorizes one player connection for the current desktop page session.
- The login page accepts that PIN or scans the same direct-player QR shown on the desktop.

The public PeerJS service requires internet access and has availability and usage limits. WebRTC may fail on restrictive or symmetric-NAT networks because this app does not provide a custom TURN relay. Buffering absorbs stalls and uneven throughput, but the connection still has to average more than about 130 kbit/s; on a slower link playback keeps pausing to rebuffer. The desktop needs WebCodecs Opus encoding (current Chrome or Edge); the phone needs `AudioWorklet` support.

## Fallback decoder build and licenses

`public/libav/` holds a custom libav.js 6.10.9 variant (FFmpeg 9.0) that contains only what the fallback needs: libavformat demuxers (mov/mp4, caf, ape, wv, tak, asf, dsf, iff), libavcodec decoders (alac, ape, wavpack, tak, wmav1, wmav2, wmapro, wmalossless, dsd_lsbf, dsd_msbf and their planar forms), libavfilter (`aresample`, `aformat`, `anull`), libswresample and libavutil. The FFmpeg parts are built without `--enable-gpl` or `--enable-nonfree`, so they are licensed under the **GNU LGPL 2.1 or later**; the full license text is embedded at the top of `libav-6.10.9.0-airside.wasm.mjs`. The libav.js wrapper code is under the ISC-style license from the libav.js project. No GPL or third-party codec libraries are included.

To rebuild it (for example to change the codec list), activate the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) and run:

```sh
scripts/build-libav.sh
```

The script pins the libav.js commit, lists the configuration fragments, checks that FFmpeg was configured as LGPL-only, and copies the three files into `public/libav/`. The corresponding FFmpeg source is the FFmpeg 9.0 release that libav.js downloads and patches during that build.

## Test samples

`samples/` holds one short file per fallback format. See [`samples/README.md`](samples/README.md) for where each one comes from. Put the folder on the desktop and open it in Airside to try the fallback decoder.

## Checks

```sh
npm test
npm run build
```

`npm test` includes decoding every file in `samples/` with the fallback decoder in Node.

The production build is written to `docs/`, ready for GitHub Pages deployment from the repository's `/docs` directory. The build also writes `docs/rabbit-r1-qr.png` and its source payload to `docs/rabbit-r1-creation.json`.
