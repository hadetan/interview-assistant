'use strict';

const SAFE_ENV_KEYS = new Set([
    'API_BASE_URL',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_REDIRECT_URI'
]);

const buildSafeEnv = (env = process.env) => {
    const safe = {};
    for (const key of SAFE_ENV_KEYS) {
        const value = typeof env[key] === 'string' ? env[key].trim() : '';
        if (value) {
            safe[key] = value;
        }
    }
    return safe;
};

const registerAuthHandlers = ({ ipcMain, authStore, env = process.env, onTokenSet, onTokenCleared, openExternal } = {}) => {
    if (!ipcMain || !authStore) {
        throw new Error('IPC registration requires ipcMain and authStore instances.');
    }

    const oauthSubscribers = new Map();
    const pendingOAuthPayloads = [];

    const deliverOAuthPayload = (webContents, payload) => {
        if (!webContents || webContents.isDestroyed()) {
            return false;
        }
        try {
            webContents.send('auth:oauth-callback', payload);
            return true;
        } catch (error) {
            console.warn('[AuthIPC] Failed to deliver OAuth callback.', error);
            return false;
        }
    };

    const emitOAuthCallback = (payload) => {
        if (!payload || typeof payload !== 'object') {
            return false;
        }
        let delivered = false;
        for (const subscriber of oauthSubscribers.values()) {
            const { webContents } = subscriber;
            if (deliverOAuthPayload(webContents, payload)) {
                delivered = true;
            }
        }
        if (!delivered) {
            pendingOAuthPayloads.push(payload);
        }
        return delivered;
    };

    const subscribeToOAuthCallbacks = (event) => {
        const sender = event?.sender;
        if (!sender) {
            return;
        }
        const id = sender.id;
        if (!oauthSubscribers.has(id)) {
            const cleanup = () => {
                oauthSubscribers.delete(id);
            };
            sender.once('destroyed', cleanup);
            oauthSubscribers.set(id, { webContents: sender, cleanup });
        }
        if (pendingOAuthPayloads.length > 0) {
            const queued = pendingOAuthPayloads.splice(0, pendingOAuthPayloads.length);
            for (const payload of queued) {
                deliverOAuthPayload(sender, payload);
            }
        }
    };

    const unsubscribeFromOAuthCallbacks = (event) => {
        const sender = event?.sender;
        if (!sender) {
            return;
        }
        const id = sender.id;
        if (!oauthSubscribers.has(id)) {
            return;
        }
        const record = oauthSubscribers.get(id);
        if (record?.cleanup) {
            try {
                sender.removeListener('destroyed', record.cleanup);
            } catch (_error) {
                // ignore removal failures
            }
        }
        oauthSubscribers.delete(id);
    };

    ipcMain.handle('auth:get-token', async () => {
        const accessToken = authStore.loadAccessToken();
        return { ok: true, accessToken };
    });

    ipcMain.handle('auth:set-token', async (_event, payload = {}) => {
        const next = typeof payload.accessToken === 'string' ? payload.accessToken : '';
        const accessToken = authStore.saveAccessToken(next);
        if (typeof onTokenSet === 'function') {
            try {
                onTokenSet({ accessToken });
            } catch (error) {
                console.warn('[AuthIPC] onTokenSet callback failed.', error);
            }
        }
        return { ok: true, accessToken };
    });

    ipcMain.handle('auth:clear-token', async () => {
        authStore.clearAccessToken();
        if (typeof onTokenCleared === 'function') {
            try {
                onTokenCleared();
            } catch (error) {
                console.warn('[AuthIPC] onTokenCleared callback failed.', error);
            }
        }
        return { ok: true };
    });

    ipcMain.handle('env:get', async () => ({ ok: true, env: buildSafeEnv(env) }));

    if (typeof ipcMain.on === 'function') {
        ipcMain.on('auth:oauth-subscribe', subscribeToOAuthCallbacks);
        ipcMain.on('auth:oauth-unsubscribe', unsubscribeFromOAuthCallbacks);
    }

    ipcMain.handle('auth:launch-oauth', async (_event, payload = {}) => {
        const url = typeof payload.url === 'string' ? payload.url.trim() : '';
        if (!url) {
            return { ok: false, error: 'Missing OAuth URL.' };
        }
        if (typeof openExternal !== 'function') {
            return { ok: false, error: 'OAuth launcher unavailable.' };
        }
        try {
            await openExternal(url);
            return { ok: true };
        } catch (error) {
            console.warn('[AuthIPC] Failed to open OAuth URL.', error);
            return { ok: false, error: error?.message || 'Failed to launch OAuth URL.' };
        }
    });

    return { emitOAuthCallback };
};

module.exports = {
    registerAuthHandlers
};
