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

const registerAuthHandlers = ({ ipcMain, authStore, env = process.env, onTokenSet, onTokenCleared } = {}) => {
    if (!ipcMain || !authStore) {
        throw new Error('IPC registration requires ipcMain and authStore instances.');
    }

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
};

module.exports = {
    registerAuthHandlers
};
