const normalizeChunkBuffer = (data) => {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
    }
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer);
    }
    return Buffer.from(data || []);
};

const registerTranscriptionHandlers = ({
    ipcMain,
    BrowserWindow,
    ensureTranscriptionService,
    getTranscriptionService,
    transcriptionConfig,
    sessionWindowMap
}) => {
    if (!ipcMain?.handle || !ipcMain?.on) {
        throw new Error('ipcMain with handle/on is required to register transcription handlers.');
    }
    const windowMap = sessionWindowMap || new Map();
    const maxBytes = transcriptionConfig?.streaming?.maxChunkBytes;

    const handleStart = async (event, payload = {}) => {
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

        windowMap.set(sessionId, targetWindow.id);

        targetWindow.once?.('closed', () => {
            windowMap.delete(sessionId);
            service.stopSession(sessionId).catch(() => {});
        });

        return { sessionId };
    };

    const handleChunk = async (_event, payload = {}) => {
        if (!payload?.sessionId || !payload?.data) {
            return;
        }

        const service = getTranscriptionService ? getTranscriptionService() : null;
        if (!service) {
            return;
        }

        const buffer = normalizeChunkBuffer(payload.data);
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
    };

    const handleStop = async (_event, payload = {}) => {
        if (!payload?.sessionId) {
            return { ok: false };
        }

        const service = await ensureTranscriptionService();
        windowMap.delete(payload.sessionId);
        await service.stopSession(payload.sessionId);
        return { ok: true };
    };

    ipcMain.handle('transcription:start', handleStart);
    ipcMain.on('transcription:chunk', handleChunk);
    ipcMain.handle('transcription:stop', handleStop);

    return { handleStart, handleChunk, handleStop };
};

module.exports = {
    registerTranscriptionHandlers,
    normalizeChunkBuffer
};
