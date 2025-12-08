const { contextBridge, ipcRenderer } = require('electron');

const normalizeChunkPayload = (data) => {
    if (!data) {
        return null;
    }

    if (Buffer.isBuffer(data)) {
        return data;
    }

    if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
    }

    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer);
    }

    return Buffer.from(data);
};

contextBridge.exposeInMainWorld('electronAPI', {
    getDesktopSources: (options) => ipcRenderer.invoke('desktop-capture:get-sources', options),
    getPlatform: () => process.platform,
    getChunkTimesliceMs: () => {
        const raw = process.env.TRANSCRIPTION_CHUNK_TIMESLICE_MS || process.env.CHUNK_TIMESLICE_MS || '';
        const parsed = parseInt(String(raw || ''), 10);
        // Use the current app default of 120ms if parsing fails or value is out of bounds
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return 200;
        }
        // reasonable bounds to avoid extreme values (< 20ms or > 5000ms)
        const MIN = 20; const MAX = 5000;
        return Math.min(MAX, Math.max(MIN, parsed));
    },
    transcription: {
        startSession: (metadata) => ipcRenderer.invoke('transcription:start', metadata),
        stopSession: (sessionId) => ipcRenderer.invoke('transcription:stop', { sessionId }),
        sendChunk: (payload) => {
            if (!payload?.sessionId) {
                return;
            }
            const normalized = {
                ...payload,
                data: normalizeChunkPayload(payload.data)
            };
            ipcRenderer.send('transcription:chunk', normalized);
        },
        onEvent: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = (_event, payload) => callback(payload);
            ipcRenderer.on('transcription:stream', listener);
            return () => ipcRenderer.removeListener('transcription:stream', listener);
        }
    }
});
