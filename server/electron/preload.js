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

const validDirections = new Set(['left', 'right', 'up', 'down']);

const sanitizeDirection = (direction) => {
    const normalized = typeof direction === 'string' ? direction.toLowerCase() : '';
    if (!validDirections.has(normalized)) {
        return '';
    }
    return normalized;
};

contextBridge.exposeInMainWorld('electronAPI', {
    getDesktopSources: (options) => ipcRenderer.invoke('desktop-capture:get-sources', options),
    getPlatform: () => process.platform,
    getChunkTimesliceMs: () => {
        const raw = process.env.TRANSCRIPTION_CHUNK_TIMESLICE_MS || process.env.CHUNK_TIMESLICE_MS || '';
        const parsed = parseInt(String(raw || ''), 10);
        const DEFAULT_TIMESLICE_MS = 80;
        // Use a low-latency default if parsing fails or value is out of bounds
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return DEFAULT_TIMESLICE_MS;
        }
        // reasonable bounds to avoid extreme values (< 20ms or > 5000ms)
        const MIN = 20; const MAX = 5000;
        return Math.min(MAX, Math.max(MIN, parsed));
    },
    controlWindow: {
        onToggleCapture: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = () => callback();
            ipcRenderer.on('control-window:toggle-capture', listener);
            return () => ipcRenderer.removeListener('control-window:toggle-capture', listener);
        },
        onToggleMic: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = () => callback();
            ipcRenderer.on('control-window:toggle-mic', listener);
            return () => ipcRenderer.removeListener('control-window:toggle-mic', listener);
        },
        onToggleGuide: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = () => callback();
            ipcRenderer.on('control-window:toggle-guide', listener);
            return () => ipcRenderer.removeListener('control-window:toggle-guide', listener);
        },
        onScrollUp: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = () => callback();
            ipcRenderer.on('control-window:scroll-up', listener);
            return () => ipcRenderer.removeListener('control-window:scroll-up', listener);
        },
        onScrollDown: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = () => callback();
            ipcRenderer.on('control-window:scroll-down', listener);
            return () => ipcRenderer.removeListener('control-window:scroll-down', listener);
        },
        onClearTranscripts: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = () => callback();
            ipcRenderer.on('control-window:clear-transcript', listener);
            return () => ipcRenderer.removeListener('control-window:clear-transcript', listener);
        },
        onAssistantSend: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = () => callback();
            ipcRenderer.on('control-window:assistant-send', listener);
            return () => ipcRenderer.removeListener('control-window:assistant-send', listener);
        },
        onAssistantAttach: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = (_event, payload) => callback(payload);
            ipcRenderer.on('control-window:assistant-attach', listener);
            return () => ipcRenderer.removeListener('control-window:assistant-attach', listener);
        }
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
    },
    assistant: {
        sendMessage: (payload) => ipcRenderer.invoke('assistant:send', payload),
        attachImage: (payload) => ipcRenderer.invoke('assistant:attach-image', payload),
        finalizeDraft: (payload) => ipcRenderer.invoke('assistant:finalize-draft', payload),
        discardDraft: (payload) => ipcRenderer.invoke('assistant:discard-draft', payload),
        clearHistory: (payload) => ipcRenderer.invoke('assistant:clear-history', payload),
        stop: (sessionId) => {
            if (!sessionId) {
                return Promise.resolve({ ok: false });
            }
            return ipcRenderer.invoke('assistant:stop', { sessionId });
        },
        onEvent: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = (_event, payload) => callback(payload);
            ipcRenderer.on('assistant:stream', listener);
            return () => ipcRenderer.removeListener('assistant:stream', listener);
        }
    },
    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        getGeneral: () => ipcRenderer.invoke('settings:get-general'),
        set: (payload) => ipcRenderer.invoke('settings:set', payload),
        testConnection: (payload) => ipcRenderer.invoke('settings:test-connection', payload),
        listModels: (payload) => ipcRenderer.invoke('settings:list-models', payload),
        close: () => ipcRenderer.invoke('settings:close'),
        openPreview: () => ipcRenderer.invoke('settings:open-preview'),
        closePreview: () => ipcRenderer.invoke('settings:close-preview'),
        syncPreview: (payload) => ipcRenderer.send('settings:preview-sync', payload),
        onGeneralUpdated: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = (_event, payload) => callback(payload);
            ipcRenderer.on('settings:general-updated', listener);
            return () => ipcRenderer.removeListener('settings:general-updated', listener);
        },
        onPreviewClosed: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = () => callback();
            ipcRenderer.on('settings:preview-closed', listener);
            return () => ipcRenderer.removeListener('settings:preview-closed', listener);
        },
        onPreviewSync: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = (_event, payload) => callback(payload);
            ipcRenderer.on('settings:preview-sync', listener);
            return () => ipcRenderer.removeListener('settings:preview-sync', listener);
        }
    },
    overlay: {
        moveDirection: (direction) => {
            const safeDirection = sanitizeDirection(direction);
            if (!safeDirection) {
                return;
            }
            ipcRenderer.send('overlay:move-direction', { direction: safeDirection });
        },
        movementHandledGlobally: true
    },
    permissions: {
        getStatus: () => ipcRenderer.invoke('permissions:get-status'),
        refreshStatus: () => ipcRenderer.invoke('permissions:refresh-status'),
        acknowledge: () => ipcRenderer.invoke('permissions:acknowledge'),
        onStatus: (callback) => {
            if (typeof callback !== 'function') {
                return () => {};
            }
            const listener = (_event, status) => callback(status);
            ipcRenderer.on('permissions:status', listener);
            return () => ipcRenderer.removeListener('permissions:status', listener);
        }
    }
});
