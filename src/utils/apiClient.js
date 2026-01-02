import axios from 'axios';
import { defaultAuthTokenManager } from './authToken.js';
import { defaultRuntimeConfig } from './runtimeConfig.js';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

const alignBaseUrlWithWindow = (baseURL) => {
    if (typeof window === 'undefined' || !baseURL) {
        return baseURL;
    }
    let parsed;
    try {
        parsed = new URL(baseURL);
    } catch (_error) {
        return baseURL;
    }

    const currentHostname = window.location?.hostname || '';
    if (!currentHostname || currentHostname === parsed.hostname) {
        return baseURL;
    }

    const isBothLocal = LOCAL_HOSTNAMES.has(parsed.hostname) && LOCAL_HOSTNAMES.has(currentHostname);
    if (!isBothLocal) {
        return baseURL;
    }

    parsed.hostname = currentHostname;
    return parsed.toString();
};

const extractAccessToken = (response) => {
    const token = response?.data?.data?.session?.accessToken;
    return typeof token === 'string' ? token : '';
};

const attachInterceptors = (instance, tokenManager, { onForceLogout } = {}) => {
    let refreshPromise = null;
    const forceLogout = async () => {
        if (typeof onForceLogout === 'function') {
            await onForceLogout();
            return;
        }
        await tokenManager.clearAccessToken();
    };

    instance.interceptors.request.use(async (config) => {
        if (config._skipAuthToken) {
            return config;
        }
        const token = await tokenManager.getAccessToken();
        if (token) {
            config.headers = config.headers || {};
            if (!config.headers.Authorization) {
                config.headers.Authorization = `Bearer ${token}`;
            }
        }
        return config;
    });

    /**
     * NOTE: This refresh endpoint relies on cookie-based authentication.
     * The axios instance created in `createApiClient` is configured with `withCredentials: true`,
     * so the browser automatically sends any session cookies set by the backend.
     * If cookies are not correctly configured or the backend does not issue a session cookie,
     * this request will fail and `forceLogout` will be triggered.
     */

    const refreshSession = async () => {
        if (!refreshPromise) {
            refreshPromise = instance.post('/auth/google/session/refresh', {}, { _skipAuthRefresh: true, _skipAuthToken: true })
                .then(async (response) => {
                    const nextToken = extractAccessToken(response) || '';
                    if (!nextToken) {
                        await forceLogout();
                        return '';
                    }
                    await tokenManager.setAccessToken(nextToken);
                    return nextToken;
                })
                .catch(async (error) => {
                    await forceLogout();
                    throw error;
                })
                .finally(() => {
                    refreshPromise = null;
                });
        }
        return refreshPromise;
    };

    instance.interceptors.response.use(
        (response) => response,
        async (error) => {
            const response = error?.response;
            const config = error?.config || {};
            if (!response || response.status !== 401 || config._retry || config._skipAuthRefresh) {
                return Promise.reject(error);
            }
            config._retry = true;
            try {
                const nextToken = await refreshSession();
                if (!nextToken) {
                    return Promise.reject(error);
                }
                config.headers = config.headers || {};
                config.headers.Authorization = `Bearer ${nextToken}`;
                return instance(config);
            } catch (refreshError) {
                return Promise.reject(refreshError);
            }
        }
    );
};

export const createApiClient = ({ axiosLib = axios, tokenManager = defaultAuthTokenManager, configProvider = defaultRuntimeConfig, adapter } = {}) => {
    const clientPromise = (async () => {
        const runtimeConfig = await configProvider.getConfig();
        const rawBaseURL = runtimeConfig.API_BASE_URL || '';
        const baseURL = alignBaseUrlWithWindow(rawBaseURL);
        const instance = axiosLib.create({
            baseURL,
            withCredentials: true,
            timeout: 15000,
            validateStatus: (status) => status >= 200 && status < 300,
            adapter: adapter || undefined
        });
        attachInterceptors(instance, tokenManager, { onForceLogout: () => tokenManager.clearAccessToken() });
        return instance;
    })();

    const getClient = () => clientPromise;

    const logout = async () => {
        const client = await getClient();
        try {
            await client.post('/auth/logout', {}, { _skipAuthRefresh: true });
        } finally {
            await tokenManager.clearAccessToken();
        }
    };

    const setAccessToken = async (accessToken) => tokenManager.setAccessToken(accessToken);

    return {
        getClient,
        logout,
        setAccessToken,
        tokenManager
    };
};

export const defaultApiClient = createApiClient();
export const getApiClient = () => defaultApiClient.getClient();
export const logout = () => defaultApiClient.logout();
export const setAccessToken = (accessToken) => defaultApiClient.setAccessToken(accessToken);
