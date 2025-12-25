'use strict';

const keytar = require('keytar');

const DEFAULT_SERVICE_NAME = 'poc-ai-system-capture';

const normalizeAccount = (prefix, value) => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!normalized) {
        throw new Error('Account identifier is required for secure storage.');
    }
    return `${prefix}${normalized}`;
};

const createSecureStore = ({
    serviceName = DEFAULT_SERVICE_NAME,
    keytarModule = keytar
} = {}) => {
    if (!keytarModule) {
        throw new Error('Keytar module is unavailable. Unable to persist secrets securely.');
    }

    const getSecret = async (account) => {
        if (!account) {
            return null;
        }
        const value = await keytarModule.getPassword(serviceName, account);
        return typeof value === 'string' ? value : null;
    };

    const setSecret = async (account, secret) => {
        if (!account) {
            throw new Error('Account identifier is required to store a secret.');
        }
        const normalized = typeof secret === 'string' ? secret.trim() : '';
        if (!normalized) {
            await deleteSecret(account);
            return { saved: false };
        }
        await keytarModule.setPassword(serviceName, account, normalized);
        return { saved: true };
    };

    const deleteSecret = async (account) => {
        if (!account) {
            return { deleted: false };
        }
        const deleted = await keytarModule.deletePassword(serviceName, account);
        return { deleted }; // keytar returns boolean
    };

    const hasSecret = async (account) => {
        const value = await getSecret(account);
        return typeof value === 'string' && value.length > 0;
    };

    const assistantAccount = (provider) => normalizeAccount('assistant:', provider);

    const getAssistantApiKey = async (provider) => {
        try {
            return await getSecret(assistantAccount(provider));
        } catch (error) {
            console.error('[SecureStore] Failed to read assistant API key', error);
            return null;
        }
    };

    const setAssistantApiKey = async (provider, apiKey) => {
        try {
            return await setSecret(assistantAccount(provider), apiKey);
        } catch (error) {
            console.error('[SecureStore] Failed to persist assistant API key', error);
            throw error;
        }
    };

    const deleteAssistantApiKey = async (provider) => {
        try {
            return await deleteSecret(assistantAccount(provider));
        } catch (error) {
            console.error('[SecureStore] Failed to delete assistant API key', error);
            throw error;
        }
    };

    const hasAssistantApiKey = async (provider) => {
        try {
            return await hasSecret(assistantAccount(provider));
        } catch (error) {
            console.error('[SecureStore] Failed to verify assistant API key presence', error);
            return false;
        }
    };

    return {
        getSecret,
        setSecret,
        deleteSecret,
        hasSecret,
        getAssistantApiKey,
        setAssistantApiKey,
        deleteAssistantApiKey,
        hasAssistantApiKey
    };
};

module.exports = {
    createSecureStore,
    DEFAULT_SERVICE_NAME
};
