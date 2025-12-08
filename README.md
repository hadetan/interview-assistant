# Screen & Audio Capture

Electron proof of concept for capturing the entire screen with optional system audio across Linux, macOS, and Windows. The renderer is a React + Vite experience that talks to the isolated Electron preload layer via `window.electronAPI`. Recordings are saved as `.webm` files in the user's `Videos/` directory with timestamped filenames.

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

The `dev` script launches Vite's React renderer (with hot reload) and Electron side-by-side. Click **Start Recording** to launch the desktop portal, choose the desired screen/window, then use **Stop Recording** to finalize the `.webm`. Status messages highlight whether system audio is included and where the file was saved.

Need to run only the renderer or Electron entry points?

- `npm run dev:renderer` – start Vite alone (useful for styling/DOM work)
- `npm run dev:electron` – run Electron that points at an existing dev server (expects Vite to already be running)
- `npm start` – launch Electron against the last production renderer build (falls back to raw `src/` files if the build is missing)

## AI Transcription (AssemblyAI)
- Copy `.env.example` to `.env` and set `ASSEMBLYAI_API_KEY`. No other providers are supported.
- Install FFmpeg on your system or provide `TRANSCRIPTION_FFMPEG_PATH` so the app can extract audio from recordings.
- Realtime transcription streams PCM audio to AssemblyAI's websocket API using the low-latency `AssemblyLiveClient`. Sessions fail fast if no API key is configured.
- Batch transcription (`transcription/worker.js`) uploads saved recordings to AssemblyAI's REST API and writes results to `Videos/ScreenAudioCapture/transcripts/<recording-name>.txt`.
- Status messages in the UI reflect queued, running, and completed transcription jobs; errors surface without blocking new recordings.
- Set `TRANSCRIPTION_ENABLED=false` in your environment to skip AI processing while keeping video capture intact.

### Testing realtime streaming locally

Use the optional harness to stream an existing PCM file through the realtime pipeline:

```bash
ASSEMBLYAI_API_KEY=... node scripts/test-realtime-assembly.js /path/to/16khz-mono.pcm
```

The script logs partial/final transcripts plus latency metrics so you can verify end-to-end performance stays under ~200 ms.

### Controlling chunk size (media recorder timeslice)

- Use the `TRANSCRIPTION_CHUNK_TIMESLICE_MS` environment variable to control how often `MediaRecorder` emits audio chunks in the renderer. Example to use 200ms:
```bash
TRANSCRIPTION_CHUNK_TIMESLICE_MS=200 npm start
```
- If unset, the default is 120ms. Values are sanitized to a reasonable range (20–5000 ms).
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

If a `.env` file exists at the project root when you run `npm run build`, electron-builder will copy it into the app resources and the app will load it at runtime so services (like AssemblyAI) are available in the packaged artifact.

Notes:
- We intentionally do **not** commit `.env` to the repo by default. If you want the packaged app to include runtime environment variables, create a `.env` locally or supply CI steps that generate it prior to running `npm run build`.
- Alternatively, you can override environment variables at runtime by exporting them before launching the AppImage:
	```bash
	ASSEMBLYAI_API_KEY=... ./dist/ScreenAudioCapture-1.0.0-x86_64.AppImage
	```

## Platform Audio Notes
- **Linux**: PipeWire delivers system audio alongside the desktop stream. If tracks are unavailable, the app continues with video-only capture.
- **Windows**: Chromium requests WASAPI loopback audio for the selected display. When unavailable, recording falls back to video-only and a status message appears.
- **macOS**: macOS does not expose system audio natively. Install a loopback driver and set it as the system/default input to capture output audio; otherwise recordings contain video-only.
