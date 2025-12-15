const { randomUUID } = require('node:crypto');

const registerAssistantHandlers = ({
    ipcMain,
    BrowserWindow,
    ensureAssistantService,
    getAssistantService,
    sessionWindowMap
}) => {
    if (!ipcMain?.handle) {
        throw new Error('ipcMain.handle is required to register assistant handlers.');
    }
    const windowMap = sessionWindowMap || new Map();

    const handleSend = async (event, payload = {}) => {
        const service = await ensureAssistantService();
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (!senderWindow) {
            throw new Error('Unable to determine window for assistant request.');
        }
        const text = typeof payload.text === 'string' ? payload.text : '';
        const sessionId = randomUUID();
        const response = await service.sendMessage({ sessionId, text });
        windowMap.set(sessionId, senderWindow.id);
        if (typeof senderWindow.once === 'function') {
            senderWindow.once('closed', () => {
                windowMap.delete(sessionId);
                const svc = typeof getAssistantService === 'function' ? getAssistantService() : null;
                svc?.cancelSession?.(sessionId);
            });
        }
        return response;
    };

    const handleStop = async (_event, payload = {}) => {
        if (!payload?.sessionId) {
            return { ok: false };
        }
        const service = await ensureAssistantService();
        await service.cancelSession(payload.sessionId);
        windowMap.delete(payload.sessionId);
        return { ok: true };
    };

    ipcMain.handle('assistant:send', handleSend);
    ipcMain.handle('assistant:stop', handleStop);

    return {
        handleSend,
        handleStop
    };
};

module.exports = {
    registerAssistantHandlers
};
