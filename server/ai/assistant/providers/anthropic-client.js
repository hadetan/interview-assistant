const { EventEmitter } = require('node:events');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

class AnthropicClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
        this.apiKey = typeof options.apiKey === 'string' ? options.apiKey : '';
        this.defaultModel = typeof options.model === 'string' ? options.model : '';
        this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
            ? options.requestTimeoutMs
            : DEFAULT_TIMEOUT_MS;
        this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs)
            ? options.connectTimeoutMs
            : DEFAULT_CONNECT_TIMEOUT_MS;
        this.maxOutputTokens = Number.isFinite(options.maxOutputTokens)
            ? options.maxOutputTokens
            : DEFAULT_MAX_OUTPUT_TOKENS;

        this.client = null;
        this.abortController = null;
        this.streamPromise = null;
        this.timeoutId = null;
        this.connectTimeoutId = null;
        this.accumulatedText = '';
        this.activeStream = null;
    }

    ensureClient() {
        if (!this.client) {
            this.client = new Anthropic({
                apiKey: this.apiKey,
                baseURL: this.baseUrl,
                timeout: this.requestTimeoutMs
            });
        }
        return this.client;
    }

    async startStream(options = {}) {
        if (this.streamPromise) {
            throw new Error('Assistant request already in progress.');
        }
        if (!this.apiKey) {
            throw new Error('Anthropic API key is not configured.');
        }

        const {
            messages,
            prompt,
            attachments,
            model,
            systemPrompt,
            stream = true,
            maxTokens
        } = options;

        const resolvedModel = (model || this.defaultModel || '').trim();
        if (!resolvedModel) {
            throw new Error('Assistant model is not configured.');
        }

        const builtMessages = this.resolveMessages(messages, { prompt, attachments });
        if (!builtMessages.length) {
            throw new Error('Assistant request requires at least one message.');
        }

        const payload = {
            model: resolvedModel,
            messages: builtMessages,
            max_tokens: Number.isFinite(maxTokens) ? maxTokens : this.maxOutputTokens
        };
        if (systemPrompt) {
            payload.system = systemPrompt;
        }

        this.abortController = new AbortController();
        this.installTimeouts();
        this.accumulatedText = '';

        const client = this.ensureClient();
        const shouldStream = stream !== false;
        const runner = shouldStream
            ? this.runStreamingRequest(client, payload)
            : this.runNonStreamingRequest(client, payload);

        this.streamPromise = runner
            .catch((error) => {
                if (this.didAbort(error)) {
                    return;
                }
                this.emit('error', error instanceof Error ? error : new Error(String(error)));
            })
            .finally(() => {
                this.clearState();
            });

        process.nextTick(() => {
            this.emit('partial', { delta: '', text: '' });
        });

        return { ok: true };
    }

    resolveMessages(messages, fallbackInput) {
        if (Array.isArray(messages) && messages.length > 0) {
            return messages;
        }
        return this.buildSingleUserMessage(fallbackInput);
    }

    async runStreamingRequest(client, payload) {
        const stream = client.messages.stream(
            { ...payload, stream: true },
            { signal: this.abortController.signal }
        );
        this.activeStream = stream;

        const handleText = (delta = '', snapshot = '') => {
            this.clearConnectTimeout();
            const runningText = snapshot || (delta ? this.accumulatedText + delta : this.accumulatedText);
            this.accumulatedText = runningText;
            this.emit('partial', { delta: delta || '', text: runningText });
        };

        const handleConnect = () => {
            this.clearConnectTimeout();
        };

        stream.on('text', handleText);
        stream.on('connect', handleConnect);

        try {
            const finalMessage = await stream.finalMessage();
            this.clearConnectTimeout();
            const text = this.extractTextFromMessage(finalMessage);
            this.accumulatedText = text;
            this.emit('final', { text, stopReason: finalMessage.stop_reason || 'completed' });
        } finally {
            stream.off('text', handleText);
            stream.off('connect', handleConnect);
            this.activeStream = null;
        }
    }

    async runNonStreamingRequest(client, payload) {
        const response = await client.messages.create(payload, { signal: this.abortController.signal });
        this.clearConnectTimeout();
        const text = this.extractTextFromMessage(response);
        this.accumulatedText = text;
        this.emit('final', { text, stopReason: response.stop_reason || 'completed' });
    }

    async cancel() {
        this.abortActiveRequest();
        try {
            await this.streamPromise;
        } catch (error) {
            if (!this.didAbort(error)) {
                throw error;
            }
        } finally {
            this.clearState();
        }
    }

    abortActiveRequest() {
        if (this.activeStream && typeof this.activeStream.abort === 'function') {
            try {
                this.activeStream.abort();
            } catch (_error) {
                // ignore abort errors
            }
        }
        if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
        }
    }

    didAbort(error) {
        if (!error) {
            return false;
        }
        if (error?.name === 'AbortError') {
            return true;
        }
        if (Anthropic?.APIUserAbortError && error instanceof Anthropic.APIUserAbortError) {
            return true;
        }
        return false;
    }

    buildSingleUserMessage({ prompt, attachments } = {}) {
        const text = typeof prompt === 'string' ? prompt.trim() : '';
        const content = [];

        if (Array.isArray(attachments)) {
            for (const attachment of attachments) {
                const mime = typeof attachment?.mime === 'string' ? attachment.mime : '';
                const data = typeof attachment?.data === 'string' ? attachment.data : '';
                if (mime && data) {
                    content.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mime,
                            data
                        }
                    });
                }
            }
        }

        if (text) {
            content.push({ type: 'text', text });
        }

        if (!content.length) {
            return [];
        }

        return [{ role: 'user', content }];
    }

    extractTextFromMessage(messagePayload) {
        const content = Array.isArray(messagePayload?.content) ? messagePayload.content : [];
        let text = '';
        for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
                text += block.text;
            }
        }
        return text;
    }

    installTimeouts() {
        this.clearTimeouts();
        if (this.requestTimeoutMs > 0) {
            this.timeoutId = setTimeout(() => {
                this.abortActiveRequest();
                this.emit('error', new Error('Assistant request timed out.'));
            }, this.requestTimeoutMs);
        }
        if (this.connectTimeoutMs > 0) {
            this.connectTimeoutId = setTimeout(() => {
                this.abortActiveRequest();
                this.emit('error', new Error('Assistant connection timed out.'));
            }, this.connectTimeoutMs);
        }
    }

    clearConnectTimeout() {
        if (this.connectTimeoutId) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = null;
        }
    }

    clearTimeouts() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        if (this.connectTimeoutId) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = null;
        }
    }

    clearState() {
        this.clearTimeouts();
        this.streamPromise = null;
        this.abortController = null;
        this.activeStream = null;
        this.accumulatedText = '';
    }

    async listModels() {
        if (!this.apiKey) {
            throw new Error('Anthropic API key is not configured.');
        }
        const client = this.ensureClient();
        const response = await client.models.list();
        const data = Array.isArray(response?.data) ? response.data : [];
        return data
            .map((model) => {
                const id = typeof model?.id === 'string' ? model.id : (typeof model?.name === 'string' ? model.name : '');
                if (!id) {
                    return null;
                }
                const displayName = typeof model?.display_name === 'string' && model.display_name.trim()
                    ? model.display_name.trim()
                    : id;
                return { id, name: displayName };
            })
            .filter(Boolean);
    }

    async testConnection() {
        try {
            await this.listModels();
            return { ok: true };
        } catch (error) {
            const message = error?.message || 'Unable to connect to Anthropic.';
            return {
                ok: false,
                error: message
            };
        }
    }
}

module.exports = {
    AnthropicClient
};
