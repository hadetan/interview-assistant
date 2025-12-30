'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AUTH_FILENAME = 'auth.json';

const ensureDirectory = ({ fsModule, targetPath }) => {
    const dir = path.dirname(targetPath);
    if (!fsModule.existsSync(dir)) {
        fsModule.mkdirSync(dir, { recursive: true });
    }
};

const readFileSafe = ({ fsModule, targetPath }) => {
    try {
        if (!fsModule.existsSync(targetPath)) {
            return {};
        }
        const raw = fsModule.readFileSync(targetPath, 'utf8');
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
    } catch (error) {
        console.error('[AuthStore] Failed to read auth file, ignoring.', error);
    }
    return {};
};

const writeFileSafe = ({ fsModule, targetPath, data }) => {
    ensureDirectory({ fsModule, targetPath });
    fsModule.writeFileSync(targetPath, JSON.stringify(data, null, 2), 'utf8');
};

const createAuthStore = ({ app, fsModule = fs, pathModule = path } = {}) => {
    if (!app || typeof app.getPath !== 'function') {
        throw new Error('Electron app instance is required to manage auth storage.');
    }

    const resolveFilePath = () => {
        const userData = app.getPath('userData');
        if (!userData) {
            throw new Error('Unable to determine userData path for auth storage.');
        }
        return pathModule.join(userData, AUTH_FILENAME);
    };

    const loadAll = () => readFileSafe({ fsModule, targetPath: resolveFilePath() });

    const loadAccessToken = () => {
        const store = loadAll();
        if (typeof store.accessToken === 'string') {
            return store.accessToken;
        }
        return '';
    };

    const saveAccessToken = (accessToken) => {
        const sanitized = typeof accessToken === 'string' ? accessToken.trim() : '';
        if (!sanitized) {
            writeFileSafe({ fsModule, targetPath: resolveFilePath(), data: {} });
            return '';
        }
        const payload = {
            accessToken: sanitized,
            updatedAt: new Date().toISOString()
        };
        writeFileSafe({ fsModule, targetPath: resolveFilePath(), data: payload });
        return sanitized;
    };

    const clearAccessToken = () => {
        writeFileSafe({ fsModule, targetPath: resolveFilePath(), data: {} });
        return '';
    };

    return {
        resolveFilePath,
        loadAll,
        loadAccessToken,
        saveAccessToken,
        clearAccessToken
    };
};

module.exports = {
    createAuthStore,
    AUTH_FILENAME
};
