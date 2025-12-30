const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const fixedConfigProvider = {
    getConfig: async () => ({ API_BASE_URL: 'http://localhost:3000/api' })
};

const makeBridge = (initialToken = '') => {
    let token = initialToken;
    const counters = {
        get: 0,
        set: 0,
        clear: 0
    };

    return {
        auth: {
            getAccessToken: async () => {
                counters.get += 1;
                return { accessToken: token };
            },
            setAccessToken: async (next) => {
                counters.set += 1;
                token = typeof next === 'string' ? next : (next?.accessToken || '');
                return { accessToken: token };
            },
            clearAccessToken: async () => {
                counters.clear += 1;
                token = '';
            }
        },
        env: {
            get: async () => ({ env: { API_BASE_URL: 'http://localhost:3000/api' } })
        },
        counters,
        get token() {
            return token;
        }
    };
};

const matchesUrl = (config, suffix) => {
    const url = config.url || '';
    return url === suffix || url.endsWith(suffix);
};

const buildClient = async ({ bridge, adapter }) => {
    const { createApiClient } = await import('../src/utils/apiClient.js');
    const { createAuthTokenManager } = await import('../src/utils/authToken.js');
    const tokenManager = createAuthTokenManager({ bridge });
    return createApiClient({ axiosLib: axios, tokenManager, configProvider: fixedConfigProvider, adapter });
};

test('attaches cached bearer token to requests', async () => {
    const bridge = makeBridge('seed-token');
    const calls = [];
    const adapter = async (config) => {
        calls.push(config.headers.Authorization || '');
        return { status: 200, statusText: 'OK', data: { ok: true }, headers: {}, config };
    };

    const clientFactory = await buildClient({ bridge, adapter });
    const client = await clientFactory.getClient();
    await client.get('/ping');

    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'Bearer seed-token');
    assert.equal(bridge.counters.get, 1);
});

test('refreshes on 401, retries once, and persists new token', async () => {
    const bridge = makeBridge('expired-token');
    let refreshCalls = 0;
    let protectedCalls = 0;

    const adapter = async (config) => {
        if (matchesUrl(config, '/auth/google/session/refresh')) {
            refreshCalls += 1;
            return {
                status: 200,
                statusText: 'OK',
                data: { data: { session: { accessToken: 'new-token' } } },
                headers: {},
                config
            };
        }
        if (matchesUrl(config, '/secure')) {
            protectedCalls += 1;
            if (!config._retry) {
                return Promise.reject({ config, response: { status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config } });
            }
            return {
                status: 200,
                statusText: 'OK',
                data: { ok: true, auth: config.headers.Authorization },
                headers: {},
                config
            };
        }
        return { status: 404, statusText: 'Not Found', data: {}, headers: {}, config };
    };

    const clientFactory = await buildClient({ bridge, adapter });
    const client = await clientFactory.getClient();
    const response = await client.get('/secure');

    assert.equal(refreshCalls, 1);
    assert.equal(protectedCalls, 2); // original + retry
    assert.equal(response.data.auth, 'Bearer new-token');
    assert.equal(bridge.counters.set, 1);
    assert.equal(bridge.token, 'new-token');
});

test('refresh failure clears cached token and rejects', async () => {
    const bridge = makeBridge('expired-token');
    let refreshCalls = 0;

    const adapter = async (config) => {
        if (matchesUrl(config, '/auth/google/session/refresh')) {
            refreshCalls += 1;
            return Promise.reject({ config, response: { status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config } });
        }
        if (matchesUrl(config, '/secure')) {
            return Promise.reject({ config, response: { status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config } });
        }
        return { status: 404, statusText: 'Not Found', data: {}, headers: {}, config };
    };

    const clientFactory = await buildClient({ bridge, adapter });
    const client = await clientFactory.getClient();

    await assert.rejects(client.get('/secure'));
    assert.equal(refreshCalls, 1);
    assert.equal(bridge.counters.clear, 1);
    assert.equal(bridge.token, '');
});

test('refresh without returned token forces logout and rejects', async () => {
    const bridge = makeBridge('expired-token');
    let refreshCalls = 0;

    const adapter = async (config) => {
        if (matchesUrl(config, '/auth/google/session/refresh')) {
            refreshCalls += 1;
            return { status: 200, statusText: 'OK', data: { data: { session: {} } }, headers: {}, config };
        }
        if (matchesUrl(config, '/secure')) {
            return Promise.reject({ config, response: { status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config } });
        }
        return { status: 404, statusText: 'Not Found', data: {}, headers: {}, config };
    };

    const clientFactory = await buildClient({ bridge, adapter });
    const client = await clientFactory.getClient();

    await assert.rejects(client.get('/secure'));
    assert.equal(refreshCalls, 1);
    assert.equal(bridge.counters.clear, 1);
    assert.equal(bridge.token, '');
});

test('refresh is single-flight across concurrent 401s', async () => {
    const bridge = makeBridge('expired-token');
    let refreshCalls = 0;
    let protectedCalls = 0;

    const adapter = async (config) => {
        if (matchesUrl(config, '/auth/google/session/refresh')) {
            refreshCalls += 1;
            return {
                status: 200,
                statusText: 'OK',
                data: { data: { session: { accessToken: 'new-token' } } },
                headers: {},
                config
            };
        }
        if (matchesUrl(config, '/secure')) {
            protectedCalls += 1;
            if (!config._retry) {
                return Promise.reject({ config, response: { status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config } });
            }
            return { status: 200, statusText: 'OK', data: { ok: true }, headers: {}, config };
        }
        return { status: 404, statusText: 'Not Found', data: {}, headers: {}, config };
    };

    const clientFactory = await buildClient({ bridge, adapter });
    const client = await clientFactory.getClient();

    const [first, second] = await Promise.all([client.get('/secure'), client.get('/secure')]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(refreshCalls, 1);
    assert.equal(bridge.counters.set, 1);
    assert.equal(bridge.counters.get, 1); // hydrated once then reused
    assert.equal(protectedCalls, 4); // two initial + two retries
});
