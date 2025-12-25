const DEFAULT_ANTHROPIC_CONFIG = {
    baseUrl: 'https://api.anthropic.com',
    requestTimeoutMs: 120_000,
    connectTimeoutMs: 60_000,
    maxOutputTokens: 1024
};

const DEFAULT_GPT_CONFIG = {
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 120_000,
    connectTimeoutMs: 60_000,
    maxOutputTokens: 1024
};

const { systemPrompts, userPrompts } = require('./assistantPrompt');

const normalizeNumber = (value, fallback) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return fallback;
};

module.exports = function loadAssistantConfig(options = {}) {
    const provider = typeof options.provider === 'string' ? options.provider.trim().toLowerCase() : '';
    const model = typeof options.model === 'string' ? options.model.trim() : '';
    const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
    const providerConfigInput = typeof options.providerConfig === 'object' && options.providerConfig !== null
        ? options.providerConfig
        : {};

    const providerMissing = !provider;
    const modelMissing = !model;
    const apiKeyMissing = !apiKey;

    const providerConfig = {};

    if (provider === 'anthropic') {
        const anthropicOptions = typeof providerConfigInput.anthropic === 'object' && providerConfigInput.anthropic !== null
            ? providerConfigInput.anthropic
            : providerConfigInput;
        providerConfig.anthropic = {
            baseUrl: typeof anthropicOptions.baseUrl === 'string' && anthropicOptions.baseUrl.trim()
                ? anthropicOptions.baseUrl.trim()
                : DEFAULT_ANTHROPIC_CONFIG.baseUrl,
            apiKey,
            model,
            requestTimeoutMs: normalizeNumber(anthropicOptions.requestTimeoutMs, DEFAULT_ANTHROPIC_CONFIG.requestTimeoutMs),
            connectTimeoutMs: normalizeNumber(anthropicOptions.connectTimeoutMs, DEFAULT_ANTHROPIC_CONFIG.connectTimeoutMs),
            maxOutputTokens: normalizeNumber(anthropicOptions.maxOutputTokens, DEFAULT_ANTHROPIC_CONFIG.maxOutputTokens)
        };
    } else if (provider === 'gpt') {
        const gptOptions = typeof providerConfigInput.gpt === 'object' && providerConfigInput.gpt !== null
            ? providerConfigInput.gpt
            : providerConfigInput;
        providerConfig.gpt = {
            baseUrl: typeof gptOptions.baseUrl === 'string' && gptOptions.baseUrl.trim()
                ? gptOptions.baseUrl.trim()
                : DEFAULT_GPT_CONFIG.baseUrl,
            apiKey,
            model,
            requestTimeoutMs: normalizeNumber(gptOptions.requestTimeoutMs, DEFAULT_GPT_CONFIG.requestTimeoutMs),
            connectTimeoutMs: normalizeNumber(gptOptions.connectTimeoutMs, DEFAULT_GPT_CONFIG.connectTimeoutMs),
            maxOutputTokens: normalizeNumber(gptOptions.maxOutputTokens, DEFAULT_GPT_CONFIG.maxOutputTokens)
        };
    }

    const isEnabled = !providerMissing && !modelMissing && !apiKeyMissing;

    return {
        provider,
        model,
        isEnabled,
        missing: {
            provider: providerMissing,
            model: modelMissing,
            apiKey: apiKeyMissing
        },
        systemPrompts,
        userPrompts,
        providerConfig
    };
};
