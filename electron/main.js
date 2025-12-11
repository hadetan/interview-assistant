const fs = require('node:fs');
const path = require('node:path');
// Load `.env` from packaged resourcesPath first (for production builds), then fall back to working dir
const { config: dotenvConfig } = require('dotenv');
try {
    const resourcesEnvPath = path.join(process.resourcesPath || process.cwd(), '.env');
    if (fs.existsSync(resourcesEnvPath)) {
        dotenvConfig({ path: resourcesEnvPath });
        console.log('[Main] Loaded environment from resources .env');
    } else {
        dotenvConfig();
        console.log('[Main] Loaded environment from project .env (if present)');
    }
} catch (err) {
    // ensure we fallback silently in dev
    dotenvConfig();
}

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut } = require('electron');
const loadTranscriptionConfig = require('../config/transcription');
const { createTranscriptionService } = require('../transcription');

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

let transcriptionService = null;
let transcriptionInitPromise = null;
let transcriptionConfig = null;
const sessionWindowMap = new Map();
let controlWindow = null;
let transcriptWindow = null;

const WINDOW_VERTICAL_GAP = 14;
const WINDOW_TOP_MARGIN = 70;

const normalizeFlagValue = (value) => {
    if (value === undefined || value === null) {
        return '';
    }
    return String(value).trim().toLowerCase();
};

const argvFlags = process.argv
    .slice(1)
    .map((arg) => normalizeFlagValue(arg));

const isTruthyFlag = (value) => {
    const normalized = normalizeFlagValue(value);
    if (!normalized) {
        return false;
    }
    return !['0', 'false', 'off', 'no'].includes(normalized);
};

const hasArgFlag = (...candidates) => argvFlags.some((arg) => candidates.includes(arg));

const offModeActive = isTruthyFlag(process.env.OFF) || hasArgFlag('off', '--off');

const shouldDisableContentProtection = () => {
    if (offModeActive) {
        return true;
    }
    if (isTruthyFlag(process.env.NO_CONTENT_PROTECTION)) {
        return true;
    }
    return hasArgFlag('--no-content-protection', 'no-content-protection');
};

const stealthModeEnabled = !offModeActive;
const contentProtectionEnabledByDefault = !shouldDisableContentProtection();

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

const resolveRendererEntry = () => {
    const distEntry = path.join(__dirname, '..', 'dist', 'renderer', 'index.html');
    if (fs.existsSync(distEntry)) {
        return distEntry;
    }
    return path.join(__dirname, '..', 'src', 'index.html');
};

const loadRendererForWindow = (targetWindow, windowVariant) => {
    if (!targetWindow) {
        return;
    }

    if (process.env.ELECTRON_START_URL) {
        let targetUrl;
        try {
            const parsed = new URL(process.env.ELECTRON_START_URL);
            parsed.searchParams.set('window', windowVariant);
            targetUrl = parsed.toString();
        } catch (_error) {
            targetUrl = process.env.ELECTRON_START_URL;
        }
        targetWindow.loadURL(targetUrl);
        return;
    }

    targetWindow.loadFile(resolveRendererEntry(), { query: { window: windowVariant } });
};

const positionOverlayWindows = () => {
    if (!controlWindow && !transcriptWindow) {
        return;
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    if (!primaryDisplay) {
        return;
    }

    const workArea = primaryDisplay.workArea || primaryDisplay.bounds;
    const areaWidth = workArea?.width ?? primaryDisplay.workAreaSize?.width ?? primaryDisplay.size?.width;
    const originX = workArea?.x ?? 0;
    const originY = workArea?.y ?? 0;

    if (controlWindow && !controlWindow.isDestroyed()) {
        const controlBounds = controlWindow.getBounds();
        const controlX = originX + Math.round((areaWidth - controlBounds.width) / 2);
        const controlY = originY + WINDOW_TOP_MARGIN;
        controlWindow.setPosition(controlX, controlY);

        if (transcriptWindow && !transcriptWindow.isDestroyed()) {
            const transcriptBounds = transcriptWindow.getBounds();
            const transcriptX = originX + Math.round((areaWidth - transcriptBounds.width) / 2);
            const transcriptY = controlY + controlBounds.height + WINDOW_VERTICAL_GAP;
            transcriptWindow.setPosition(transcriptX, transcriptY);
        }
        return;
    }

    if (transcriptWindow && !transcriptWindow.isDestroyed()) {
        const transcriptBounds = transcriptWindow.getBounds();
        const transcriptX = originX + Math.round((areaWidth - transcriptBounds.width) / 2);
        const transcriptY = originY + WINDOW_TOP_MARGIN;
        transcriptWindow.setPosition(transcriptX, transcriptY);
    }
};

const overlayWebPreferences = {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false
};

const createControlWindow = () => {
    if (controlWindow && !controlWindow.isDestroyed()) {
        return controlWindow;
    }

    controlWindow = new BrowserWindow({
        width: 320,
        height: 90,
        transparent: true,
        frame: false,
        skipTaskbar: stealthModeEnabled,
        autoHideMenuBar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        focusable: !stealthModeEnabled,
        show: false,
        hasShadow: false,
        backgroundColor: '#00000000',
        hiddenInMissionControl: stealthModeEnabled,
        acceptFirstMouse: true,
        webPreferences: overlayWebPreferences,
    });

    if (stealthModeEnabled) {
        controlWindow.setAlwaysOnTop(true, 'screen-saver');
        controlWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
        controlWindow.setAlwaysOnTop(true, 'normal');
        controlWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    controlWindow.setFullScreenable(false);
    controlWindow.setIgnoreMouseEvents(true, { forward: true });

    controlWindow.once('ready-to-show', () => {
        if (stealthModeEnabled) {
            controlWindow?.showInactive();
        } else {
            controlWindow?.show();
            controlWindow?.focus();
        }
        controlWindow?.setIgnoreMouseEvents(true, { forward: true });
        positionOverlayWindows();
    });

    controlWindow.on('resized', positionOverlayWindows);

    controlWindow.on('closed', () => {
        controlWindow = null;
        if (transcriptWindow && !transcriptWindow.isDestroyed()) {
            transcriptWindow.close();
        }
    });

    controlWindow.on('focus', () => {
        if (stealthModeEnabled) {
            controlWindow.blur();
        }
    });

    loadRendererForWindow(controlWindow, 'control');
    return controlWindow;
};

const createTranscriptWindow = () => {
    if (transcriptWindow && !transcriptWindow.isDestroyed()) {
        return transcriptWindow;
    }

    transcriptWindow = new BrowserWindow({
        width: 420,
        height: 280,
        transparent: true,
        frame: false,
        skipTaskbar: stealthModeEnabled,
        autoHideMenuBar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        focusable: !stealthModeEnabled,
        show: false,
        hasShadow: false,
        backgroundColor: '#00000000',
        hiddenInMissionControl: stealthModeEnabled,
        acceptFirstMouse: true,
        webPreferences: overlayWebPreferences
    });

    if (stealthModeEnabled) {
        transcriptWindow.setAlwaysOnTop(true, 'screen-saver');
        transcriptWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        transcriptWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
        transcriptWindow.setAlwaysOnTop(true, 'normal');
        transcriptWindow.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
        transcriptWindow.setIgnoreMouseEvents(false);
    }
    transcriptWindow.setFullScreenable(false);

    transcriptWindow.once('ready-to-show', () => {
        if (stealthModeEnabled) {
            transcriptWindow?.showInactive();
        } else {
            transcriptWindow?.show();
            transcriptWindow?.focus();
        }
        positionOverlayWindows();
    });

    transcriptWindow.on('resized', positionOverlayWindows);

    transcriptWindow.on('closed', () => {
        transcriptWindow = null;
        if (!controlWindow || controlWindow.isDestroyed()) {
            app.quit();
        }
    });

    loadRendererForWindow(transcriptWindow, 'transcript');
    return transcriptWindow;
};

app.whenReady().then(() => {
    createControlWindow();
    createTranscriptWindow();

    const toggleShortcut = 'CommandOrControl+Shift+/';
    const registered = globalShortcut.register(toggleShortcut, () => {
        const targets = [controlWindow, transcriptWindow]
            .filter((win) => win && !win.isDestroyed());
        targets.forEach((win) => {
            win.webContents.send('control-window:toggle-capture');
        });
    });
    if (!registered) {
        console.warn(`[Shortcut] Failed to register ${toggleShortcut} accelerator.`);
    } else {
        console.log(`[Shortcut] Registered ${toggleShortcut} accelerator.`);
    }

    screen.on('display-metrics-changed', positionOverlayWindows);
    screen.on('display-added', positionOverlayWindows);
    screen.on('display-removed', positionOverlayWindows);

    app.on('activate', () => {
        if (!controlWindow || controlWindow.isDestroyed()) {
            createControlWindow();
        }
        if (!transcriptWindow || transcriptWindow.isDestroyed()) {
            createTranscriptWindow();
        }
        positionOverlayWindows();
    });

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
                if (!transcriptWindow || transcriptWindow.isDestroyed()) {
                    return;
                }
                transcriptWindow.webContents.send('transcription:stream', payload);
            };

            service.on('session-started', ({ sessionId, sourceName }) => {
                emitToOwner(sessionId, { type: 'started', sessionId, sourceName });
                emitToTranscriptOverlay({ type: 'started', sessionId, sourceName });
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
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});
ipcMain.handle('desktop-capture:get-sources', async (_event, opts = {}) => {
    const sources = await desktopCapturer.getSources({
        types: opts.types || ['screen', 'window'],
        fetchWindowIcons: true,
        thumbnailSize: { width: 320, height: 200 }
    });

    return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail?.toDataURL() || null,
        display_id: source.display_id || null
    }));
});

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

ipcMain.handle('transcription:start', async (event, payload = {}) => {
    const service = await ensureTranscriptionService();
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow) {
        throw new Error('Unable to determine window for transcription start.');
    }

    const sessionId = await service.startSession({
        sessionId: payload.sessionId,
        sourceName: payload.sourceName,
        platform: payload.platform
    });

    sessionWindowMap.set(sessionId, targetWindow.id);

    targetWindow.once('closed', () => {
        sessionWindowMap.delete(sessionId);
        service.stopSession(sessionId).catch(() => { });
    });

    return { sessionId };
});

ipcMain.on('transcription:chunk', async (_event, payload = {}) => {
    if (!payload?.sessionId || !payload?.data) {
        return;
    }

    const service = transcriptionService;
    if (!service) {
        return;
    }

    const buffer = Buffer.isBuffer(payload.data) ? payload.data : Buffer.from(payload.data);
    const maxBytes = transcriptionConfig?.streaming?.maxChunkBytes || 128 * 1024;
    if (buffer.length > maxBytes) {
        console.warn('[Transcription] Dropping chunk over maxBytes', buffer.length);
        return;
    }

    const captureTimestamp = Number(payload.captureTimestamp ?? payload.timestamp) || Date.now();
    const ipcTimestamp = Date.now();

    service.pushChunk(payload.sessionId, {
        buffer,
        mimeType: payload.mimeType || 'audio/webm;codecs=opus',
        sequence: payload.sequence,
        clientTimestamp: captureTimestamp,
        captureTimestamp,
        ipcTimestamp
    });
});

ipcMain.handle('transcription:stop', async (_event, payload = {}) => {
    if (!payload?.sessionId) {
        return { ok: false };
    }

    const service = await ensureTranscriptionService();
    sessionWindowMap.delete(payload.sessionId);
    await service.stopSession(payload.sessionId);
    return { ok: true };
});
