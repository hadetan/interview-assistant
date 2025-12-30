const defaultBridge = typeof window !== 'undefined' ? window.electronAPI : globalThis.electronAPI;

const sanitizeValue = (value) => {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

export const createRuntimeConfig = ({ bridge = defaultBridge } = {}) => {
    let cache = null;
    let loadPromise = null;

    const fetchEnv = async () => {
        if (!bridge?.env?.get) {
            return {};
        }
        try {
            const result = await bridge.env.get();
            const env = result?.env || result || {};
            if (!env || typeof env !== 'object') {
                return {};
            }
            const sanitized = {};
            for (const [key, value] of Object.entries(env)) {
                const next = sanitizeValue(value);
                if (next) {
                    sanitized[key] = next;
                }
            }
            return sanitized;
        } catch (_error) {
            return {};
        }
    };

    const ensureCache = async () => {
        if (cache) {
            return cache;
        }
        if (!loadPromise) {
            loadPromise = fetchEnv()
                .then((env) => {
                    cache = env;
                    return cache;
                })
                .finally(() => {
                    loadPromise = null;
                });
        }
        return loadPromise;
    };

    const getConfig = async () => {
        const env = await ensureCache();
        return { ...env };
    };

    return { getConfig };
};

export const defaultRuntimeConfig = createRuntimeConfig();
