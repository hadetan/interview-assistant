const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, nativeImage } = require('electron');
const loadTranscriptionConfig = require('../config/transcription');
const loadAssistantConfig = require('../config/assistant');
const { createTranscriptionService } = require('../ai/transcription');
const { createAssistantService } = require('../ai/assistant');
const {
    loadEnv,
    parseArgvFlags,
    offModeActive: computeOffModeActive,
    shouldDisableContentProtection: computeDisableContentProtection
} = require('./env');
const { registerDesktopCaptureHandler } = require('./ipc/desktop-capture');
const { createWindowManager } = require('./window-manager');
const { createShortcutManager } = require('./shortcuts');
const { registerTranscriptionHandlers } = require('./ipc/transcription');
const { registerAssistantHandlers } = require('./ipc/assistant');

loadEnv();

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

let transcriptionService = null;
let transcriptionInitPromise = null;
let transcriptionConfig = null;
const sessionWindowMap = new Map();
let assistantService = null;
let assistantInitPromise = null;
let assistantConfig = null;
const assistantSessionWindowMap = new Map();

const WINDOW_VERTICAL_GAP = 14;
const WINDOW_TOP_MARGIN = 12;
const MOVE_STEP_PX = 50;

const argvFlags = parseArgvFlags();
const offModeActive = computeOffModeActive(process.env, argvFlags);
const contentProtectionEnabledByDefault = !computeDisableContentProtection(process.env, argvFlags);
const stealthModeEnabled = !offModeActive;

const applyContentProtection = (targetWindow) => {
    if (!targetWindow?.setContentProtection) {
        console.warn('[ContentProtection] setContentProtection is unavailable on this platform.');
        return;
    }

    try {
        targetWindow.setContentProtection(contentProtectionEnabledByDefault);
        const reportedState = typeof targetWindow.isContentProtected === 'function'
            ? targetWindow.isContentProtected()
            : 'unknown';
        console.log(
            `[ContentProtection] Applied ${contentProtectionEnabledByDefault ? 'ENABLED' : 'DISABLED'} to window #${targetWindow.id} (reported: ${reportedState}).`
        );
    } catch (error) {
        console.warn('[ContentProtection] Failed to set content protection on window', error);
    }
};

console.log(
    `[ContentProtection] Default state: ${contentProtectionEnabledByDefault ? 'ENABLED' : 'DISABLED'} (OFF flag ${contentProtectionEnabledByDefault ? 'not detected' : 'detected'}).`
);

console.log(
    `[Overlay] Stealth mode ${stealthModeEnabled ? 'ENABLED' : 'DISABLED'} (OFF flag ${offModeActive ? 'detected' : 'not detected'}).`
);

app.on('browser-window-created', (_event, window) => {
    applyContentProtection(window);
});

const windowManager = createWindowManager({
    BrowserWindow,
    screen,
    nativeImage,
    pathModule: path,
    fsModule: fs,
    stealthModeEnabled,
    contentProtectionEnabledByDefault,
    windowVerticalGap: WINDOW_VERTICAL_GAP,
    windowTopMargin: WINDOW_TOP_MARGIN,
    moveStepPx: MOVE_STEP_PX,
    app
});

const shortcutManager = createShortcutManager({ globalShortcut });

const ensureTranscriptionService = async () => {
    if (transcriptionInitPromise) {
        try {
            await transcriptionInitPromise;
        } catch (error) {
            console.error('[Transcription] Initialization failed', error);
        }
    }

    if (!transcriptionService) {
        throw new Error('Transcription service is unavailable.');
    }

    return transcriptionService;
};

const ensureAssistantService = async () => {
    if (assistantInitPromise) {
        try {
            await assistantInitPromise;
        } catch (error) {
            console.error('[Assistant] Initialization failed', error);
        }
    }

    if (!assistantService) {
        throw new Error('Assistant service is unavailable.');
    }

    return assistantService;
};

const initializeApp = async () => {
    windowManager.createControlWindow();
    windowManager.createTranscriptWindow();

    const {
        moveOverlaysBy,
        positionOverlayWindows,
        getControlWindow,
        getTranscriptWindow,
        moveStepPx
    } = windowManager;

    assistantConfig = loadAssistantConfig();

    // Controller commands registry
    const toggleShortcut = 'CommandOrControl+Shift+/';
    shortcutManager.registerShortcut(toggleShortcut, () => {
        const targets = [getControlWindow(), getTranscriptWindow()]
            .filter((win) => win && !win.isDestroyed());
        targets.forEach((win) => {
            win.webContents.send('control-window:toggle-capture');
        });
    });

    const scrollUpShortcut = 'CommandOrControl+Shift+Up';
    shortcutManager.registerShortcut(scrollUpShortcut, () => {
        const transcriptWindow = getTranscriptWindow();
        if (transcriptWindow && !transcriptWindow.isDestroyed()) {
            transcriptWindow.webContents.send('control-window:scroll-up');
        }
    });

    const scrollDownShortcut = 'CommandOrControl+Shift+Down';
    shortcutManager.registerShortcut(scrollDownShortcut, () => {
        const transcriptWindow = getTranscriptWindow();
        if (transcriptWindow && !transcriptWindow.isDestroyed()) {
            transcriptWindow.webContents.send('control-window:scroll-down');
        }
    });

    const clearTranscriptShortcut = 'CommandOrControl+Shift+G';
    shortcutManager.registerShortcut(clearTranscriptShortcut, () => {
        const transcriptWindow = getTranscriptWindow();
        if (transcriptWindow && !transcriptWindow.isDestroyed()) {
            transcriptWindow.webContents.send('control-window:clear-transcript');
        }
    });

    const toggleMicShortcut = 'CommandOrControl+Shift+M';
    shortcutManager.registerShortcut(toggleMicShortcut, () => {
        const controlWindow = getControlWindow();
        if (controlWindow && !controlWindow.isDestroyed()) {
            controlWindow.webContents.send('control-window:toggle-mic');
        }
    });

    const assistantEnabled = assistantConfig?.isEnabled !== false;
    let attachImageShortcut = null;

    if (assistantEnabled) {
        const assistantShortcut = 'CommandOrControl+Enter';
        shortcutManager.registerShortcut(assistantShortcut, () => {
            const transcriptWindow = getTranscriptWindow();
            if (transcriptWindow && !transcriptWindow.isDestroyed()) {
                transcriptWindow.webContents.send('control-window:assistant-send');
            }
        });

        attachImageShortcut = 'CommandOrControl+Shift+H';
        shortcutManager.registerShortcut(attachImageShortcut, async () => {
            const transcriptWindow = getTranscriptWindow();
            if (!transcriptWindow || transcriptWindow.isDestroyed()) {
                return;
            }
            try {
                const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
                const source = sources[0];
                if (!source || !source.thumbnail) {
                    throw new Error('No screen source available for capture.');
                }
                const buffer = source.thumbnail.toPNG();
                const data = buffer.toString('base64');
                transcriptWindow.webContents.send('control-window:assistant-attach', {
                    name: `${source.name || 'screen'}.png`,
                    mime: 'image/png',
                    data
                });
            } catch (error) {
                transcriptWindow.webContents.send('control-window:assistant-attach', {
                    error: error?.message || 'Failed to capture screen.'
                });
            }
        });
    }

    const moveLeft = 'CommandOrControl+Left';
    shortcutManager.registerShortcut(moveLeft, () => moveOverlaysBy(-moveStepPx, 0));

    const moveRight = 'CommandOrControl+Right';
    shortcutManager.registerShortcut(moveRight, () => moveOverlaysBy(moveStepPx, 0));

    const moveUp = 'CommandOrControl+Up';
    shortcutManager.registerShortcut(moveUp, () => moveOverlaysBy(0, -moveStepPx));

    const moveDown = 'CommandOrControl+Down';
    shortcutManager.registerShortcut(moveDown, () => moveOverlaysBy(0, moveStepPx));

    const visibilityToggleShortcut = 'CommandOrControl+Shift+Alt+B';
    shortcutManager.registerShortcut(visibilityToggleShortcut, () => {
        let controlWindow = getControlWindow();
        let transcriptWindow = getTranscriptWindow();
        const targets = [controlWindow, transcriptWindow].filter((win) => win && !win.isDestroyed());

        if (!targets.length) {
            controlWindow = getControlWindow() || windowManager.createControlWindow();
            transcriptWindow = getTranscriptWindow() || windowManager.createTranscriptWindow();
        }

        const liveTargets = [controlWindow, transcriptWindow].filter((win) => win && !win.isDestroyed());
        if (!liveTargets.length) {
            return;
        }

        const anyVisible = liveTargets.some((win) => typeof win.isVisible === 'function' && win.isVisible());

        if (anyVisible) {
            liveTargets.forEach((win) => {
                try {
                    win.hide();
                } catch (err) {
                    console.warn('[Shortcut] Failed to hide window', err);
                }
            });

            const allowedShortcuts = new Set(
                [visibilityToggleShortcut, attachImageShortcut, toggleMicShortcut].filter(Boolean)
            );
            shortcutManager.unregisterAllShortcutsExcept(allowedShortcuts);
            return;
        }

        liveTargets.forEach((win) => {
            try {
                if (stealthModeEnabled && typeof win.showInactive === 'function') {
                    win.showInactive();
                } else {
                    win.show();
                    if (win === controlWindow && !stealthModeEnabled) {
                        win.focus();
                    }
                }
            } catch (err) {
                console.warn('[Shortcut] Failed to show window', err);
            }
        });

        shortcutManager.registerAllShortcuts();
        positionOverlayWindows();
    });

    screen.on('display-metrics-changed', positionOverlayWindows);
    screen.on('display-added', positionOverlayWindows);
    screen.on('display-removed', positionOverlayWindows);

    app.on('activate', () => {
        if (!windowManager.getControlWindow() || windowManager.getControlWindow().isDestroyed()) {
            windowManager.createControlWindow();
        }
        if (!windowManager.getTranscriptWindow() || windowManager.getTranscriptWindow().isDestroyed()) {
            windowManager.createTranscriptWindow();
        }
        positionOverlayWindows();
    });

    registerDesktopCaptureHandler({ ipcMain, desktopCapturer });

    transcriptionConfig = loadTranscriptionConfig();

    transcriptionInitPromise = createTranscriptionService(transcriptionConfig)
        .then((service) => {
            transcriptionService = service;

            const emitToOwner = (sessionId, payload) => {
                const windowId = sessionWindowMap.get(sessionId);
                if (!windowId) {
                    return;
                }
                const targetWindow = BrowserWindow.fromId(windowId);
                if (!targetWindow) {
                    return;
                }
                targetWindow.webContents.send('transcription:stream', payload);
            };

            const emitToTranscriptOverlay = (payload) => {
                const transcriptWindow = getTranscriptWindow();
                if (!transcriptWindow || transcriptWindow.isDestroyed()) {
                    return;
                }
                transcriptWindow.webContents.send('transcription:stream', payload);
            };

            service.on('session-started', ({ sessionId, sourceName, sourceType }) => {
                emitToOwner(sessionId, { type: 'started', sessionId, sourceName, sourceType });
                emitToTranscriptOverlay({ type: 'started', sessionId, sourceName, sourceType });
            });

            service.on('session-update', (payload) => {
                emitToOwner(payload.sessionId, { type: 'update', ...payload });
                emitToTranscriptOverlay({ type: 'update', ...payload });
            });

            service.on('session-warning', (payload) => {
                emitToOwner(payload.sessionId, { type: 'warning', ...payload });
                emitToTranscriptOverlay({ type: 'warning', ...payload });
            });

            service.on('session-heartbeat', (payload) => {
                emitToOwner(payload.sessionId, { type: 'heartbeat', ...payload });
                emitToTranscriptOverlay({ type: 'heartbeat', ...payload });
            });

            service.on('session-error', (payload) => {
                emitToOwner(payload.sessionId, { type: 'error', ...payload });
                emitToTranscriptOverlay({ type: 'error', ...payload });
            });

            service.on('session-stopped', (payload) => {
                emitToOwner(payload.sessionId, { type: 'stopped', ...payload });
                emitToTranscriptOverlay({ type: 'stopped', ...payload });
                sessionWindowMap.delete(payload.sessionId);
            });

            return service;
        })
        .catch((error) => {
            console.error('[Transcription] Failed to initialize service', error);
            transcriptionService = null;
        });

    registerTranscriptionHandlers({
        ipcMain,
        BrowserWindow,
        ensureTranscriptionService,
        getTranscriptionService: () => transcriptionService,
        transcriptionConfig,
        sessionWindowMap
    });

    assistantInitPromise = createAssistantService(assistantConfig)
        .then((service) => {
            assistantService = service;

            const emitToOwner = (sessionId, payload) => {
                const windowId = assistantSessionWindowMap.get(sessionId);
                if (!windowId) {
                    return;
                }
                const targetWindow = BrowserWindow.fromId(windowId);
                if (!targetWindow || targetWindow.isDestroyed()) {
                    return;
                }
                targetWindow.webContents.send('assistant:stream', payload);
            };

            service.on('session-started', ({ sessionId, messageId }) => {
                emitToOwner(sessionId, { type: 'started', sessionId, messageId });
            });

            service.on('session-update', (payload) => {
                emitToOwner(payload.sessionId, { type: 'update', ...payload });
            });

            service.on('session-error', (payload) => {
                emitToOwner(payload.sessionId, { type: 'error', ...payload });
            });

            service.on('session-stopped', (payload) => {
                emitToOwner(payload.sessionId, { type: 'stopped', ...payload });
                assistantSessionWindowMap.delete(payload.sessionId);
            });

            return service;
        })
        .catch((error) => {
            console.error('[Assistant] Failed to initialize service', error);
            assistantService = null;
        });

    registerAssistantHandlers({
        ipcMain,
        BrowserWindow,
        ensureAssistantService,
        getAssistantService: () => assistantService,
        sessionWindowMap: assistantSessionWindowMap,
        assistantConfig
    });
};

app.whenReady().then(initializeApp);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

ipcMain.on('overlay:move-direction', (_event, payload = {}) => {
    const direction = typeof payload.direction === 'string' ? payload.direction.toLowerCase() : '';
    let dx = 0;
    let dy = 0;

    switch (direction) {
        case 'left':
            dx = -MOVE_STEP_PX;
            break;
        case 'right':
            dx = MOVE_STEP_PX;
            break;
        case 'up':
            dy = -MOVE_STEP_PX;
            break;
        case 'down':
            dy = MOVE_STEP_PX;
            break;
        default:
            return;
    }

    windowManager.moveOverlaysBy(dx, dy);
});

module.exports = {
    initializeApp
};
