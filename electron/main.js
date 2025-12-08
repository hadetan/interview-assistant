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

const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const loadTranscriptionConfig = require('../config/transcription');
const { createTranscriptionService } = require('../transcription');

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

let transcriptionService = null;
let transcriptionInitPromise = null;
let transcriptionConfig = null;
const sessionWindowMap = new Map();

const resolveRendererEntry = () => {
    const distEntry = path.join(__dirname, '..', 'dist', 'renderer', 'index.html');
    if (fs.existsSync(distEntry)) {
        return distEntry;
    }
    return path.join(__dirname, '..', 'src', 'index.html');
};

const createMainWindow = () => {
    const mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    if (process.env.ELECTRON_START_URL) {
        mainWindow.loadURL(process.env.ELECTRON_START_URL);
    } else {
        mainWindow.loadFile(resolveRendererEntry());
    }
};

app.whenReady().then(() => {
    createMainWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
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

            service.on('session-started', ({ sessionId, sourceName }) => {
                emitToOwner(sessionId, { type: 'started', sessionId, sourceName });
            });

            service.on('session-update', (payload) => {
                emitToOwner(payload.sessionId, { type: 'update', ...payload });
            });

            service.on('session-warning', (payload) => {
                emitToOwner(payload.sessionId, { type: 'warning', ...payload });
            });

            service.on('session-heartbeat', (payload) => {
                emitToOwner(payload.sessionId, { type: 'heartbeat', ...payload });
            });

            service.on('session-error', (payload) => {
                emitToOwner(payload.sessionId, { type: 'error', ...payload });
            });

            service.on('session-stopped', (payload) => {
                emitToOwner(payload.sessionId, { type: 'stopped', ...payload });
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
        service.stopSession(sessionId).catch(() => {});
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
