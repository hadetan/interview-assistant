const DEFAULT_ANTHROPIC_CONFIG = {
    baseUrl: 'https://api.anthropic.com',
    requestTimeoutMs: 120_000,
    connectTimeoutMs: 60_000,
    maxOutputTokens: 1024
};

const systemPrompts = {
    imageMode: 'You are a coding assistant analyzing mixed media. Inspect the images and any accompanying text to decide whether the user supplied a programming problem. If a starter template, function signature, or stub code is present, you MUST implement the solution inside that exact scaffold (language, class names, method signatures) instead of rewriting it from scratch. Only create a fresh solution when no template exists. Return the complete, correct solution—code plus any extra detail only when the user explicitly asks. For purely conceptual or interview questions, answer factually in a confident interview-style tone. Always state true facts only.',
    textMode: 'You are a concise technical assistant. When the prompt describes a coding task, honor any provided function/class signatures or constraints and implement the required logic inside them. Produce the optimal solution with only the justification the user requested. When the prompt is conceptual or interview-oriented, answer with precise, factual statements in an interview-style tone. If codeOnly is requested, return only code without commentary.'
};

const userPrompts = {
    imageDefault: 'Study the screenshot. If it contains a programming problem with a provided template, fill in that template exactly. Only create a brand-new solution if no scaffold is present. Solve fully and output the final answer, adding explanations only when the user text explicitly asks.'
};

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
