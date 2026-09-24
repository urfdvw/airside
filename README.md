# Airside

Airside is a pure frontend app that streams music from a folder on a desktop browser to a mobile browser. The files never upload to an application server: the desktop reads and decodes them locally, and WebRTC sends an audio stream directly to the phone.

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
- The desktop decodes the selected audio file with Web Audio and routes it only to a `MediaStreamAudioDestinationNode`, never to its speakers.
- PeerJS's default public cloud service handles signaling. The app has no custom server, API, or database.
- A PeerJS data connection carries the file list, playback commands, progress, status, and audio renegotiation messages.
- The desktop adds a one-way Opus stereo track to that connection’s established WebRTC transport, with a 320,000 bps sender cap and SDP stereo preference.
- A random four-letter PIN determines the temporary PeerJS host ID and authorizes one player connection for the current desktop page session.
- The login page accepts that PIN or scans the same direct-player QR shown on the desktop.

The public PeerJS service requires internet access and has availability and usage limits. WebRTC may fail on restrictive or symmetric-NAT networks because this app does not provide a custom TURN relay. The 320 kbps value is a target/cap; the browser and network can adapt below it.

## Checks

```sh
npm test
npm run build
```

The production build is written to `docs/`, ready for GitHub Pages deployment from the repository's `/docs` directory. The build also writes `docs/rabbit-r1-qr.png` and its source payload to `docs/rabbit-r1-creation.json`.
