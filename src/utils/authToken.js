const defaultBridge = typeof window !== 'undefined' ? window.electronAPI : globalThis.electronAPI;

const extractToken = (value) => {
    if (typeof value === 'string') {
        return value;
    }
    if (value && typeof value === 'object') {
        if (typeof value.accessToken === 'string') {
            return value.accessToken;
        }
        if (typeof value.token === 'string') {
            return value.token;
        }
    }
    return '';
};

export const createAuthTokenManager = ({ bridge = defaultBridge } = {}) => {
    let cachedToken = '';
    let hydrated = false;
    let hydratePromise = null;

    const readFromBridge = async () => {
        if (!bridge?.auth?.getAccessToken) {
            return '';
        }
        try {
            const result = await bridge.auth.getAccessToken();
            return extractToken(result);
        } catch (_error) {
            return '';
        }
    };

    const persistToBridge = async (accessToken) => {
        if (bridge?.auth?.setAccessToken) {
            try {
                await bridge.auth.setAccessToken(accessToken);
            } catch (_error) {
                // ignore persistence failures
            }
        }
    };

    const clearBridgeToken = async () => {
        if (bridge?.auth?.clearAccessToken) {
            try {
                await bridge.auth.clearAccessToken();
                return;
            } catch (_error) {
                // ignore
            }
        }
        if (bridge?.auth?.setAccessToken) {
            try {
                await bridge.auth.setAccessToken('');
            } catch (_error) {
                // ignore
            }
        }
    };

    const hydrate = async () => {
        if (hydrated) {
            return cachedToken;
        }
        if (!hydratePromise) {
            hydratePromise = readFromBridge()
                .then((token) => {
                    cachedToken = typeof token === 'string' ? token : '';
                    hydrated = true;
                    return cachedToken;
                })
                .finally(() => {
                    hydratePromise = null;
                });
        }
        return hydratePromise;
    };

    const getAccessToken = async () => {
        await hydrate();
        return cachedToken;
    };

    const setAccessToken = async (accessToken) => {
        const sanitized = typeof accessToken === 'string' ? accessToken.trim() : '';
        cachedToken = sanitized;
        hydrated = true;
        await persistToBridge(sanitized);
        return cachedToken;
    };

    const clearAccessToken = async () => {
        cachedToken = '';
        hydrated = true;
        await clearBridgeToken();
        return '';
    };

    return {
        hydrate,
        getAccessToken,
        setAccessToken,
        clearAccessToken
    };
};

export const defaultAuthTokenManager = createAuthTokenManager();
