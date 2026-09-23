# Airside

Airside is a pure frontend app that streams music from a folder on a desktop browser to a mobile browser. The files never upload to an application server: the desktop reads and decodes them locally, and WebRTC sends an audio stream directly to the phone.

## Run locally

```sh
npm install
npm run dev
```

Open `http://localhost:5173` in desktop Chrome or Edge, choose a music folder, and use the generated player link in another tab. The full player URL, including its one-time session token, is also logged in the desktop browser console.

For a physical phone, it must be able to open the app address encoded in the QR code. Replace the displayed app address with an HTTPS deployment URL or a reachable HTTPS development URL. The File System Access API works on `localhost` or HTTPS and currently requires a supporting desktop browser.

## How it works

- `showDirectoryPicker()` grants read-only access to a folder and its subfolders.
- The desktop decodes the selected audio file with Web Audio and routes it only to a `MediaStreamAudioDestinationNode`, never to its speakers.
- PeerJS's default public cloud service handles signaling. The app has no custom server, API, or database.
- A PeerJS data connection carries the file list, play/pause/next/previous commands, progress, and status.
- A one-way PeerJS media connection carries an Opus stereo stream with a 320,000 bps sender cap and SDP stereo preference.
- A random 192-bit token in the QR/player URL authorizes one player connection for the current desktop page session.

The public PeerJS service requires internet access and has availability and usage limits. WebRTC may fail on restrictive or symmetric-NAT networks because this app does not provide a custom TURN relay. The 320 kbps value is a target/cap; the browser and network can adapt below it.

## Checks

```sh
npm test
npm run build
```

The production build is written to `docs/`, ready for GitHub Pages deployment from the repository's `/docs` directory.
