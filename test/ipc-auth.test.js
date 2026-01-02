'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerAuthHandlers } = require('../server/electron/ipc/auth');

test('auth handlers wire through to authStore', async () => {
    const handles = new Map();
    const listeners = new Map();
    const ipcMain = {
        handle: (channel, handler) => {
            handles.set(channel, handler);
        },
        on: (channel, handler) => {
            listeners.set(channel, handler);
        }
    };

    let savedValue = null;
    let clearCount = 0;
    const authStore = {
        loadAccessToken: () => 'cached-token',
        saveAccessToken: (next) => {
            savedValue = next;
            return 'persisted-token';
        },
        clearAccessToken: () => {
            clearCount += 1;
        }
    };

    const openCalls = [];
    const { emitOAuthCallback } = registerAuthHandlers({ ipcMain, authStore, env: {}, openExternal: async (url) => {
        openCalls.push(url);
    } });

    const getToken = handles.get('auth:get-token');
    assert.ok(getToken, 'expected auth:get-token handler to be registered');
    const getResult = await getToken();
    assert.deepEqual(getResult, { ok: true, accessToken: 'cached-token' });

    const setToken = handles.get('auth:set-token');
    const setResult = await setToken(null, { accessToken: ' next-token ' });
    assert.equal(savedValue, ' next-token ');
    assert.deepEqual(setResult, { ok: true, accessToken: 'persisted-token' });

    const clearToken = handles.get('auth:clear-token');
    const clearResult = await clearToken();
    assert.equal(clearCount, 1);
    assert.deepEqual(clearResult, { ok: true });

    assert.equal(typeof emitOAuthCallback, 'function');

    const sentPayloads = [];
    const fakeSender = {
        id: 42,
        isDestroyed: () => false,
        send: (_channel, payload) => {
            sentPayloads.push(payload);
        },
        once: (_event, _callback) => {},
        removeListener: () => {}
    };

    // Emit before subscription to ensure payload queues
    const deliveredBefore = emitOAuthCallback({ code: 'queued' });
    assert.equal(deliveredBefore, false);

    const subscribeHandler = listeners.get('auth:oauth-subscribe');
    assert.ok(subscribeHandler, 'expected auth:oauth-subscribe listener');
    subscribeHandler({ sender: fakeSender });
    assert.deepEqual(sentPayloads, [{ code: 'queued' }]);

    emitOAuthCallback({ code: 'delivered' });
    assert.deepEqual(sentPayloads, [{ code: 'queued' }, { code: 'delivered' }]);

    const unsubscribeHandler = listeners.get('auth:oauth-unsubscribe');
    assert.ok(unsubscribeHandler, 'expected auth:oauth-unsubscribe listener');
    unsubscribeHandler({ sender: fakeSender });
    emitOAuthCallback({ code: 'after-unsubscribe' });
    assert.deepEqual(sentPayloads, [{ code: 'queued' }, { code: 'delivered' }]);
});

test('env:get handler exposes whitelisted keys only', async () => {
    const handles = new Map();
    const ipcMain = {
        handle: (channel, handler) => {
            handles.set(channel, handler);
        },
        on: () => {}
    };

    const env = {
        API_BASE_URL: ' https://api.example.com ',
        SUPABASE_URL: 'https://sb.example.com',
        SUPABASE_ANON_KEY: 'anon',
        SUPABASE_REDIRECT_URI: '',
        SECRET_TOKEN: 'should-not-leak'
    };

    registerAuthHandlers({ ipcMain, authStore: { loadAccessToken() {}, saveAccessToken() {}, clearAccessToken() {} }, env, openExternal: async () => {} });

    const envGet = handles.get('env:get');
    const result = await envGet();
    assert.deepEqual(result, {
        ok: true,
        env: {
            API_BASE_URL: 'https://api.example.com',
            SUPABASE_URL: 'https://sb.example.com',
            SUPABASE_ANON_KEY: 'anon'
        }
    });
});

test('auth:launch-oauth delegates to openExternal', async () => {
    const handles = new Map();
    const ipcMain = {
        handle: (channel, handler) => {
            handles.set(channel, handler);
        },
        on: () => {}
    };

    const openCalls = [];
    registerAuthHandlers({
        ipcMain,
        authStore: { loadAccessToken() {}, saveAccessToken() {}, clearAccessToken() {} },
        env: {},
        openExternal: async (url) => {
            if (!url) {
                throw new Error('missing url');
            }
            openCalls.push(url);
        }
    });

    const launchHandler = handles.get('auth:launch-oauth');
    assert.ok(launchHandler, 'expected auth:launch-oauth handler');

    const successResult = await launchHandler(null, { url: 'https://example.com' });
    assert.deepEqual(successResult, { ok: true });
    assert.deepEqual(openCalls, ['https://example.com']);

    const errorResult = await launchHandler(null, { url: '' });
    assert.equal(errorResult.ok, false);
    assert.ok(errorResult.error);
});
