const { randomUUID } = require('node:crypto');

const registerAssistantHandlers = ({
    ipcMain,
    BrowserWindow,
    ensureAssistantService,
    getAssistantService,
    sessionWindowMap,
    assistantConfig
}) => {
    if (!ipcMain?.handle) {
        throw new Error('ipcMain.handle is required to register assistant handlers.');
    }
    const windowMap = sessionWindowMap || new Map();

    const assistantDisabledError = () => ({
        ok: false,
        error: {
            code: 'assistant-disabled',
            message: 'Assistant provider or model is not configured.'
        }
    });

    const ensureAvailable = async () => {
        if (assistantConfig && assistantConfig.isEnabled === false) {
            return assistantDisabledError();
        }
        try {
            const service = await ensureAssistantService();
            return { ok: true, service };
        } catch (error) {
            return {
                ok: false,
                error: {
                    code: 'assistant-unavailable',
                    message: error?.message || 'Assistant service unavailable.'
                }
            };
        }
    };

    const handleSend = async (event, payload = {}) => {
        const availability = await ensureAvailable();
        if (!availability.ok) {
            return availability;
        }
        const service = availability.service;
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
        return { ok: true, ...response };
    };

    const handleStop = async (_event, payload = {}) => {
        if (!payload?.sessionId) {
            return { ok: false };
        }
        const availability = await ensureAvailable();
        if (!availability.ok) {
            return availability;
        }
        const service = availability.service;
        await service.cancelSession(payload.sessionId);
        windowMap.delete(payload.sessionId);
        return { ok: true };
    };

    const handleAttachImage = async (_event, payload = {}) => {
        const availability = await ensureAvailable();
        if (!availability.ok) {
            return availability;
        }
        const service = availability.service;
        try {
            const result = await service.attachImage({
                draftId: payload.draftId,
                image: payload.image
            });
            return { ok: true, ...result };
        } catch (error) {
            return {
                ok: false,
                error: {
                    code: 'assistant-attach-failed',
                    message: error?.message || 'Failed to attach image.'
                }
            };
        }
    };

    const handleFinalizeDraft = async (event, payload = {}) => {
        const availability = await ensureAvailable();
        if (!availability.ok) {
            return availability;
        }
        const service = availability.service;
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (!senderWindow) {
            throw new Error('Unable to determine window for assistant finalize request.');
        }
        try {
            const response = await service.finalizeDraft({
                draftId: payload.draftId,
                messages: Array.isArray(payload.messages) ? payload.messages : [],
                codeOnly: Boolean(payload.codeOnly)
            });
            windowMap.set(response.sessionId, senderWindow.id);
            if (typeof senderWindow.once === 'function') {
                senderWindow.once('closed', () => {
                    windowMap.delete(response.sessionId);
                    const svc = typeof getAssistantService === 'function' ? getAssistantService() : null;
                    svc?.cancelSession?.(response.sessionId);
                });
            }
            return { ok: true, ...response };
        } catch (error) {
            return {
                ok: false,
                error: {
                    code: 'assistant-finalize-failed',
                    message: error?.message || 'Failed to finalize draft.'
                }
            };
        }
    };

    const handleDiscardDraft = async (_event, payload = {}) => {
        const availability = await ensureAvailable();
        if (!availability.ok) {
            return availability;
        }
        const service = availability.service;
        try {
            const result = await service.discardDraft({
                draftId: payload.draftId,
                discardAll: Boolean(payload.discardAll)
            });
            return { ok: true, ...result };
        } catch (error) {
            return {
                ok: false,
                error: {
                    code: 'assistant-discard-failed',
                    message: error?.message || 'Failed to discard draft.'
                }
            };
        }
    };

    ipcMain.handle('assistant:send', handleSend);
    ipcMain.handle('assistant:stop', handleStop);
    ipcMain.handle('assistant:attach-image', handleAttachImage);
    ipcMain.handle('assistant:finalize-draft', handleFinalizeDraft);
    ipcMain.handle('assistant:discard-draft', handleDiscardDraft);

    return {
        handleSend,
        handleStop,
        handleAttachImage,
        handleFinalizeDraft,
        handleDiscardDraft
    };
};

module.exports = {
    registerAssistantHandlers
};
