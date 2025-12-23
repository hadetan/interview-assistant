# Screen & Audio Capture

No description yet;

### Status

_Currently this is fully supported on windows OS only_

## Prerequisites

-   Node.js 18+ (tested with v22.20.0) and npm 9+.
-   **Linux**: PipeWire desktop portal (`xdg-desktop-portal`, `wireplumber`) for screen + audio capture.
-   **macOS**: macOS 13+ with Screen Recording permission granted. Install a loopback device (e.g. BlackHole) to capture system audio.

    -   Install BlackHole using homebrew:

    ```bash
        # install homebrew if not
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

        # install ffmpeg
        brew install ffmpeg

        # install blackhole loopback
        brew install --cask blackhole-2ch

            # stop coreaudiod if BlackHole is not visible in Audio MIDI Setup
        sudo pkill coreaudiod
        # Then close Audio MIDI Setup and open it again.
    ```

    -   Configure BlackHole in **Audio MIDI Setup**:
        1. Create a **Multi-Output Device** that includes both _MacBook Pro Speakers_ (or your preferred hardware output) and _BlackHole 2ch_.
        2. Keep the **sound input** pointed at your physical microphone (for example _MacBook Pro Microphone_).

-   **Windows**: Windows 10/11 with desktop capture permissions enabled.

## Quick Start (Development)

For Environment Variables please refer to the [env example](./.env.example).

Start the app:

```bash
cd /home/asus/ws/poc-screen-and-audio-capture
npm install
npm run dev
```

## Controls supported

-   `CTRL + H`: Toggle help guide
-   `CTRL + SHIFT + /`: Start or Pause the streaming
-   `CTRL + SHIFT + [up/down]` arrow: Scroll up or down on conversation
-   `CTRL + SHIFT + G`: Clear conversation
-   `CTRL + [up/down/left/right]` arrow: Position top/bottom/left/right the windows
-   `CTRL + SHIFT + B`: Hide or show windows
-   `CTRL + ENTER`: Send the asked question to A.I.
-   `CTRL + SHIFT + H`: Attaches current screen as PNG image to give it to AI. Best use is to attach coding questions and it will return the solved code.
-   `CTRL + SHIFT + M`: Turn mic on or off

## Unsupported features

-   Validation on generated code.
    -   Node vm.script(code)
    -   python -m py_compile