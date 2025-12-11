# Screen & Audio Capture

No description;

### Status
*Currently this is fully supported on windows only*

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

## Controls supported
- `CTRL + SHIFT + /`: Start or Pause the streaming
