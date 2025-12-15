const DEFAULT_PROVIDER = 'ollama';
const DEFAULT_MODEL = 'qwen2.5-coder:1.5b';
const DEFAULT_OLLAMA_CONFIG = {
    baseUrl: 'http://127.0.0.1:11434',
    requestTimeoutMs: 120_000,
    connectTimeoutMs: 10_000
};

module.exports = function loadAssistantConfig() {
    const provider = (process.env.ASSISTANT_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
    const model = (process.env.ASSISTANT_MODEL || DEFAULT_MODEL).trim();

    return {
        provider,
        model,
        providerConfig: {
            ollama: {
                baseUrl: DEFAULT_OLLAMA_CONFIG.baseUrl,
                model,
                requestTimeoutMs: DEFAULT_OLLAMA_CONFIG.requestTimeoutMs,
                connectTimeoutMs: DEFAULT_OLLAMA_CONFIG.connectTimeoutMs
            }
        }
    };
};
