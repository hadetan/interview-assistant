const DEFAULT_ANTHROPIC_CONFIG = {
    baseUrl: 'https://api.anthropic.com',
    requestTimeoutMs: 120_000,
    connectTimeoutMs: 60_000,
    maxOutputTokens: 1024
};

const { systemPrompts, userPrompts } = require('./assistantPrompt');

module.exports = function loadAssistantConfig() {
    const provider = (process.env.ASSISTANT_PROVIDER || '').trim().toLowerCase();
    const model = (process.env.ASSISTANT_MODEL || '').trim();
    const apiKey = (process.env.ASSISTANT_API_KEY || '').trim();

    const providerMissing = !provider;
    const modelMissing = !model;
    const apiKeyMissing = !apiKey;
    const isEnabled = !providerMissing && !modelMissing && !apiKeyMissing;

    const providerConfig = {};
    if (provider === 'anthropic') {
        providerConfig.anthropic = {
            baseUrl: (process.env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_CONFIG.baseUrl).trim(),
            apiKey,
            model,
            requestTimeoutMs: Number.isFinite(Number(process.env.ANTHROPIC_REQUEST_TIMEOUT_MS))
                ? Number(process.env.ANTHROPIC_REQUEST_TIMEOUT_MS)
                : DEFAULT_ANTHROPIC_CONFIG.requestTimeoutMs,
            connectTimeoutMs: Number.isFinite(Number(process.env.ANTHROPIC_CONNECT_TIMEOUT_MS))
                ? Number(process.env.ANTHROPIC_CONNECT_TIMEOUT_MS)
                : DEFAULT_ANTHROPIC_CONFIG.connectTimeoutMs,
            maxOutputTokens: Number.isFinite(Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS))
                ? Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS)
                : DEFAULT_ANTHROPIC_CONFIG.maxOutputTokens
        };
    }

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
