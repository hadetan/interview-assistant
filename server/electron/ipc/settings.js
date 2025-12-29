'use strict';

const loadAssistantConfig = require('../../config/assistant');
const { AnthropicClient } = require('../../ai/assistant/providers/anthropic-client');
const { GptClient } = require('../../ai/assistant/providers/gpt-client');

const SUPPORTED_PROVIDERS = new Set(['anthropic', 'gpt']);

const providerFactories = {
    anthropic: (config = {}) => new AnthropicClient(config),
    gpt: (config = {}) => new GptClient(config)
};

const sanitizeProvider = (raw) => {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return SUPPORTED_PROVIDERS.has(value) ? value : '';
};

const formatModels = (models) => models
    .filter(Boolean)
    .map((model) => ({
        id: model.id,
        name: model.name || model.id
    }))
    .filter((entry) => typeof entry.id === 'string' && entry.id.length > 0);

const createProviderInstance = ({ provider, options }) => {
    const factory = providerFactories[provider];
    if (!factory) {
        throw new Error(`Provider "${provider}" is not supported.`);
    }
    return factory(options || {});
};

const resolveProviderOptions = ({ provider, settingsStore, overrides = {} }) => {
    const stored = settingsStore.getAssistantSettings();
    const selectedConfig = (stored.providerConfig && stored.providerConfig[provider]) || {};
    return {
        ...selectedConfig,
        ...overrides
    };
};

const registerSettingsHandlers = ({
    ipcMain,
    settingsStore,
    secureStore,
    onSettingsApplied,
    windowManager,
    resolveAssistantConfig,
    onGeneralSettingsApplied
}) => {
    if (!ipcMain || !settingsStore || !secureStore) {
        throw new Error('IPC registration requires ipcMain, settingsStore, and secureStore instances.');
    }

    const availableProviders = Array.from(SUPPORTED_PROVIDERS);

    ipcMain.handle('settings:get', async () => {
        const stored = settingsStore.getAssistantSettings();
        const provider = sanitizeProvider(stored.provider);
        const model = typeof stored.model === 'string' ? stored.model : '';
        const providerConfig = stored.providerConfig || {};
        const hasSecret = provider ? await secureStore.hasAssistantApiKey(provider) : false;

        const general = settingsStore.getGeneralSettings();
        const previewOpen = Boolean(windowManager?.getPreviewWindow?.());

        return {
            ok: true,
            providers: availableProviders,
            config: {
                provider,
                model,
                providerConfig
            },
            general,
            previewOpen,
            missing: {
                provider: !provider,
                model: !model,
                apiKey: !hasSecret
            },
            hasSecret
        };
    });

    ipcMain.handle('settings:get-general', async () => {
        const general = settingsStore.getGeneralSettings();
        return {
            ok: true,
            general
        };
    });

    ipcMain.handle('settings:list-models', async (_event, payload = {}) => {
        const provider = sanitizeProvider(payload.provider);
        if (!provider) {
            return { ok: false, error: 'Select a valid provider before listing models.' };
        }

        const overrides = typeof payload.providerConfig === 'object' && payload.providerConfig !== null
            ? payload.providerConfig
            : {};

        let apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
        if (!apiKey) {
            apiKey = await secureStore.getAssistantApiKey(provider) || '';
        }
        if (!apiKey) {
            return { ok: false, error: 'Provide an API key to fetch models.' };
        }

        const options = resolveProviderOptions({ provider, settingsStore, overrides: { ...overrides, apiKey } });
        options.apiKey = apiKey;
        options.model = typeof payload.model === 'string' ? payload.model : (options.model || '');

        try {
            const providerInstance = createProviderInstance({ provider, options });
            const models = await providerInstance.listModels();
            return { ok: true, models: formatModels(models) };
        } catch (error) {
            return {
                ok: false,
                error: error?.message || 'Failed to fetch models.'
            };
        }
    });

    ipcMain.handle('settings:test-connection', async (_event, payload = {}) => {
        const provider = sanitizeProvider(payload.provider);
        if (!provider) {
            return { ok: false, error: 'Select a valid provider before testing the connection.' };
        }

        let apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
        if (!apiKey) {
            apiKey = await secureStore.getAssistantApiKey(provider) || '';
        }
        if (!apiKey) {
            return { ok: false, error: 'Provide an API key to test the connection.' };
        }

        const overrides = typeof payload.providerConfig === 'object' && payload.providerConfig !== null
            ? payload.providerConfig
            : {};
        const options = resolveProviderOptions({ provider, settingsStore, overrides: { ...overrides, apiKey } });
        options.apiKey = apiKey;
        options.model = typeof payload.model === 'string' ? payload.model : (options.model || '');

        try {
            const client = createProviderInstance({ provider, options });
            const result = await client.testConnection();
            if (result?.ok) {
                return { ok: true };
            }
            const message = result?.error || 'Connection test failed.';
            return { ok: false, error: message };
        } catch (error) {
            return {
                ok: false,
                error: error?.message || 'Connection test failed.'
            };
        }
    });

    ipcMain.handle('settings:set', async (_event, payload = {}) => {
        const provider = sanitizeProvider(payload.provider);
        if (!provider) {
            return { ok: false, error: 'Provider is required.' };
        }

        const model = typeof payload.model === 'string' ? payload.model.trim() : '';
        if (!model) {
            return { ok: false, error: 'Model is required.' };
        }

        const generalInput = typeof payload.general === 'object' && payload.general !== null
            ? payload.general
            : {};

        const apiKeyInput = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
        let apiKeyToPersist = apiKeyInput;

        if (!apiKeyInput) {
            const currentSettings = settingsStore.getAssistantSettings();
            const sameProviderAsStored = sanitizeProvider(currentSettings.provider) === provider;
            const hasStoredSecret = sameProviderAsStored
                ? await secureStore.hasAssistantApiKey(provider)
                : false;
            if (!hasStoredSecret) {
                return { ok: false, error: 'API key is required.' };
            }
            apiKeyToPersist = null; // reuse stored secret
        }

        const providerConfig = typeof payload.providerConfig === 'object' && payload.providerConfig !== null
            ? payload.providerConfig
            : {};

        try {
            settingsStore.setAssistantSettings({
                provider,
                model,
                providerConfig
            });
            if (apiKeyToPersist !== null) {
                await secureStore.setAssistantApiKey(provider, apiKeyToPersist);
            }
            for (const otherProvider of availableProviders) {
                if (otherProvider !== provider) {
                    await secureStore.deleteAssistantApiKey(otherProvider);
                }
            }

            const generalSettings = settingsStore.setGeneralSettings(generalInput);

            const config = resolveAssistantConfig
                ? await resolveAssistantConfig()
                : loadAssistantConfig({ provider, model, apiKey: apiKeyToPersist ?? (await secureStore.getAssistantApiKey(provider) || ''), providerConfig });

            if (typeof onSettingsApplied === 'function') {
                await onSettingsApplied({ config, provider });
            }

            if (typeof onGeneralSettingsApplied === 'function') {
                await onGeneralSettingsApplied(generalSettings);
            }

            const settingsWindow = windowManager?.getSettingsWindow?.();
            if (settingsWindow) {
                windowManager.restoreOverlayWindows?.();
                windowManager.destroySettingsWindow?.();
            }

            return { ok: true, general: generalSettings };
        } catch (error) {
            console.error('[Settings] Failed to persist settings', error);
            return {
                ok: false,
                error: error?.message || 'Failed to save settings.'
            };
        }
    });

    ipcMain.handle('settings:close', async () => {
        try {
            windowManager?.destroySettingsWindow?.();
            return { ok: true };
        } catch (error) {
            console.warn('[Settings] Failed to close settings window', error);
            return { ok: false, error: error?.message || 'Failed to close settings window.' };
        }
    });

    ipcMain.handle('settings:open-preview', async () => {
        try {
            const preview = windowManager?.createPreviewWindow?.();
            if (!preview) {
                return { ok: false, error: 'Unable to open preview window.' };
            }
            const general = settingsStore.getGeneralSettings();
            const sendGeneral = () => {
                try {
                    preview.webContents.send('settings:general-updated', { general });
                } catch (error) {
                    console.warn('[Settings] Failed to sync general settings to preview window', error);
                }
            };
            if (preview.webContents.isLoading()) {
                preview.webContents.once('did-finish-load', sendGeneral);
            } else {
                sendGeneral();
            }
            return { ok: true };
        } catch (error) {
            console.warn('[Settings] Failed to open preview window', error);
            return { ok: false, error: error?.message || 'Failed to open preview window.' };
        }
    });

    ipcMain.handle('settings:close-preview', async () => {
        try {
            windowManager?.destroyPreviewWindow?.();
            return { ok: true };
        } catch (error) {
            console.warn('[Settings] Failed to close preview window', error);
            return { ok: false, error: error?.message || 'Failed to close preview window.' };
        }
    });

    ipcMain.on('settings:preview-sync', (_event, payload = {}) => {
        const preview = windowManager?.getPreviewWindow?.();
        if (!preview) {
            return;
        }
        try {
            preview.webContents.send('settings:preview-sync', payload);
        } catch (error) {
            console.warn('[Settings] Failed to stream preview update', error);
        }
    });
};

module.exports = {
    registerSettingsHandlers,
    SUPPORTED_PROVIDERS
};
