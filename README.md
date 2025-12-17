# Screen & Audio Capture

No description yet;

### Status
*Currently this is fully supported on windows OS only*

## Prerequisites
- Node.js 18+ (tested with v22.20.0) and npm 9+.
- **Linux**: PipeWire desktop portal (`xdg-desktop-portal`, `wireplumber`) for screen + audio capture.
- **macOS**: macOS 13+ with Screen Recording permission granted. Install a loopback device (e.g. BlackHole) to capture system audio.
- **Windows**: Windows 10/11 with desktop capture permissions enabled.

## Quick Start (Development)

For Environment Variables please refer to the [env example](./.env.example).

Start the app:
```bash
cd /home/asus/ws/poc-screen-and-audio-capture
npm install
npm run dev
```

## Controls supported
- `CTRL + SHIFT + /`: Start or Pause the streaming
- `CTRL + SHIFT + [up/down]` arrow: Scroll up or down on conversation
- `CTRL + ALT + G`: Clear conversation
- `CTRL + [up/down/left/right]` arrow: Position top/bottom/left/right the windows
- `CTRL + SHIFT + ALT + B`: Hide or show windows
- `CTRL + SHIFT + ALT + ENTER`: Send the asked question to A.I.
- `CTRL + ALT + H`: Attaches current screen as PNG image to give it to AI. Best use is to attach coding questions and it will return the solved code.

## Unsupported features
- Validation on generated code.
    - Node vm.script(code)
    - python -m py_compile
- Image > OCR > AI
