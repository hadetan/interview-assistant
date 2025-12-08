# Screen & Audio Capture


Electron proof-of-concept for capturing desktop sources (screen or window) with optional system audio and performing realtime transcription using a public transcription provider (AssemblyAI by default).

The renderer is a React + Vite app that talks to a Node/Electron main process via a secure `preload.js` (context-bridged) API. The app streams captured audio chunks in realtime to a streaming transcription service and renders live transcripts with latency instrumentation.

> Note: This app does *not* automatically save `.webm` recordings to disk as part of the realtime flow. There is, however, a stand-alone offline worker that can transcribe local recordings (see "Offline / Batch transcription" below).

## Prerequisites
- Node.js 18+ (tested with v22.20.0) and npm 9+.
- **Linux**: PipeWire desktop portal (`xdg-desktop-portal`, `wireplumber`) for screen + audio capture.
- **macOS**: macOS 13+ with Screen Recording permission granted. Install a loopback device (e.g. BlackHole) to capture system audio.
- **Windows**: Windows 10/11 with desktop capture permissions enabled.

## Quick Start (Development)
```bash
cd /home/asus/ws/poc-screen-and-audio-capture
npm install
npm run dev
```

The `dev` script launches Vite's React renderer (with hot reload) and Electron side-by-side. Click **Start capture** (or `Start capture`) to launch the desktop portal and begin streaming the captured system audio to the configured transcription provider. The UI displays status and transcript; this realtime flow does not save recordings to disk by default.

Need to run only the renderer or Electron entry points?

- `npm run dev:renderer` – start Vite alone (useful for styling/DOM work)
- `npm run dev:electron` – run Electron that points at an existing dev server (expects Vite to already be running)
- `npm start` – launch Electron against the last production renderer build (falls back to raw `src/` files if the build is missing)

## AI Transcription (AssemblyAI)
- Copy `.env.example` to `.env` and set `ASSEMBLYAI_API_KEY` if you want realtime streaming transcription to work. Realtime streaming will try to connect to AssemblyAI when a valid key is available.
- Install FFmpeg on your system or provide `TRANSCRIPTION_FFMPEG_PATH` if you plan to use the offline/batch worker (the live UI does not need FFmpeg).
- Realtime transcription streams PCM audio to the configured provider via a streaming client (AssemblyAI by default). If the API key is missing or invalid, the realtime service will not be available and UI will reflect that.
- Offline / Batch transcription (`transcription/worker.js`) is a worker that accepts a path to an existing video file and writes a transcript to disk (to the transcriptsDir you configure when starting the worker). It is not invoked from the UI by default.

### Testing realtime streaming locally

The project also includes a lightweight offline worker for experimentation (e.g., `transcription/worker.js`). If you need a test harness to stream a raw PCM file to the realtime pipeline, please ask and I can add a small example script that pushes a PCM file through the streaming client.

### Controlling chunk size (media recorder timeslice)

- Use the `TRANSCRIPTION_CHUNK_TIMESLICE_MS` environment variable to control how often `MediaRecorder` emits audio chunks in the renderer. Example to use 200ms:
```bash
TRANSCRIPTION_CHUNK_TIMESLICE_MS=200 npm start
```
If unset, the default in the streaming service configuration is 150ms and values are sanitized to a reasonable range (20–5000 ms). The UI's preload provides a fallback if parsing fails.
- This affects how frequently the renderer emits `transcription:chunk` IPC events — smaller values increase periodic IPC frequency and data volume, larger values reduce IPC frequency but increase per-chunk size and potential latency.

### Silence handling & latency instrumentation

- Configure `TRANSCRIPTION_SILENCE_FILL_MS` (default 200 ms) to inject small zero-PCM frames whenever no real audio arrives, which keeps downstream ASR pipelines responsive during pauses.
- `TRANSCRIPTION_SILENCE_FRAME_MS` (default 20 ms) controls the duration of each synthetic frame.
- The streaming service now logs end-to-end timing (capture → IPC → converter → WebSocket → transcript) so you can confirm whether latency spikes originate in the app or with the provider.

## Building Installers
Always produce a fresh renderer bundle before packaging:

```bash
npm run build:renderer   # emits dist/renderer/** for Electron to load
```

`npm run build` already performs the renderer build and then invokes Electron Builder, but running it standalone is useful when testing UI output without packaging. Electron Builder can generate platform-specific artifacts:
- **Linux AppImage**
	```bash
	npm run build -- --linux
	```
- **macOS dmg**
	```bash
	npm run build -- --mac
	```
- **Windows nsis installer**
	```bash
	npm run build -- --win
	```

The resulting files appear under `dist/` with names such as `ScreenAudioCapture-<version>-mac.dmg`, `ScreenAudioCapture-<version>-win.exe`, and `ScreenAudioCapture-<version>-x86_64.AppImage`.

> **macOS signing**: Replace the sample publisher identifiers with your Team ID and run notarization before distributing. The provided entitlements plist enables Screen Recording and audio input permissions.

### Bundling environment into a packaged app

If a `.env` file exists at the project root when you run `npm run build`, electron-builder will copy it into the app resources and the main process will attempt to load it at runtime. This is convenient for experiments, but be mindful about secrets: you can supply environment variables at runtime instead.

Notes:
- We intentionally do **not** commit `.env` to the repo. If you want the packaged app to include runtime environment variables, create a `.env` locally or provide a CI step to generate it prior to running `npm run build`.
- To avoid embedding secrets in the artifact, set the environment on the host when launching the artifact:
```bash
ASSEMBLYAI_API_KEY=... ./dist/ScreenAudioCapture-1.0.0-x86_64.AppImage
```

## Platform Audio Notes
- **Linux**: PipeWire delivers system audio alongside the desktop stream. If tracks are unavailable, the app continues with video-only capture.
- **Windows**: Chromium requests WASAPI loopback audio for the selected display. When unavailable, recording falls back to video-only and a status message appears.
- **macOS**: macOS does not expose system audio natively. Install a loopback driver and set it as the system/default input to capture output audio; otherwise recordings contain video-only.
