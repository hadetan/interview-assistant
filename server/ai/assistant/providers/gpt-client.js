'use strict';

const { EventEmitter } = require('node:events');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const COMPLETIONS_PATH = '/chat/completions';
const MODELS_PATH = '/models';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

class GptClient extends EventEmitter {
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

        this.abortController = null;
        this.timeoutId = null;
        this.connectTimeoutId = null;
        this.streamPromise = null;
        this.accumulatedText = '';
    }

    resolveMessages(messages, { prompt, systemPrompt } = {}) {
        const result = [];
        if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
            result.push({ role: 'system', content: systemPrompt.trim() });
        }
        if (Array.isArray(messages) && messages.length > 0) {
            for (const message of messages) {
                if (!message || typeof message.role !== 'string' || typeof message.content !== 'string') {
                    continue;
                }
                result.push({ role: message.role, content: message.content });
            }
            return result;
        }
        const text = typeof prompt === 'string' ? prompt.trim() : '';
        if (text) {
            result.push({ role: 'user', content: text });
        }
        return result;
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

    clearConnectTimeout() {
        if (this.connectTimeoutId) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = null;
        }
    }

    clearState() {
        this.clearTimeouts();
        this.streamPromise = null;
        this.abortController = null;
        this.accumulatedText = '';
    }

    abortActiveRequest() {
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
        return false;
    }

    buildHeaders() {
        if (!this.apiKey) {
            throw new Error('GPT API key is not configured.');
        }
        return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`
        };
    }

    async startStream(options = {}) {
        if (this.streamPromise) {
            throw new Error('Assistant request already in progress.');
        }
        if (!this.apiKey) {
            throw new Error('GPT API key is not configured.');
        }
        const resolvedModel = (options.model || this.defaultModel || '').trim();
        if (!resolvedModel) {
            throw new Error('Assistant model is not configured.');
        }
        if (Array.isArray(options.attachments) && options.attachments.length > 0) {
            throw new Error('Image attachments are not supported by the GPT provider at this time.');
        }

        const messages = this.resolveMessages(options.messages, {
            prompt: options.prompt,
            systemPrompt: options.systemPrompt
        });
        if (!messages.length) {
            throw new Error('Assistant request requires at least one message.');
        }

        const payload = {
            model: resolvedModel,
            messages,
            stream: options.stream !== false,
            max_tokens: Number.isFinite(options.maxTokens) ? options.maxTokens : this.maxOutputTokens,
            temperature: typeof options.temperature === 'number' ? options.temperature : 0.2
        };

        this.abortController = new AbortController();
        this.installTimeouts();
        this.accumulatedText = '';

        const shouldStream = payload.stream === true;
        this.streamPromise = (shouldStream
            ? this.runStreamingRequest(payload)
            : this.runNonStreamingRequest(payload))
            .catch((error) => {
                if (this.didAbort(error)) {
                    return;
                }
                this.emit('error', error instanceof Error ? error : new Error(String(error)));
            })
            .finally(() => this.clearState());

        process.nextTick(() => {
            this.emit('partial', { delta: '', text: '' });
        });

        return { ok: true };
    }

    async runStreamingRequest(payload) {
        const response = await fetch(new URL(COMPLETIONS_PATH, this.baseUrl).toString(), {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(payload),
            signal: this.abortController.signal
        });

        if (!response.ok || !response.body) {
            this.clearTimeouts();
            throw new Error(`GPT streaming request failed (${response.status}).`);
        }

        this.clearConnectTimeout();
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf8');
        let buffer = '';
        let finishReason = 'completed';

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            this.clearConnectTimeout();
            buffer += decoder.decode(value, { stream: true });
            let lineBreakIndex;
            while ((lineBreakIndex = buffer.indexOf('\n')) >= 0) {
                const rawLine = buffer.slice(0, lineBreakIndex).trim();
                buffer = buffer.slice(lineBreakIndex + 1);
                if (!rawLine) {
                    continue;
                }
                if (!rawLine.toLowerCase().startsWith('data:')) {
                    continue;
                }
                const data = rawLine.slice(5).trim();
                if (data === '[DONE]') {
                    break;
                }
                try {
                    const parsed = JSON.parse(data);
                    const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
                    const delta = choice?.delta?.content || '';
                    finishReason = choice?.finish_reason || finishReason;
                    if (delta) {
                        this.accumulatedText += delta;
                        this.emit('partial', { delta, text: this.accumulatedText });
                    }
                } catch (error) {
                    console.warn('[GptClient] Failed to parse streaming chunk', error);
                }
            }
        }

        this.emit('final', { text: this.accumulatedText, stopReason: finishReason });
    }

    async runNonStreamingRequest(payload) {
        const response = await fetch(new URL(COMPLETIONS_PATH, this.baseUrl).toString(), {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify({ ...payload, stream: false }),
            signal: this.abortController.signal
        });

        const data = await response.json();
        if (!response.ok) {
            const message = data?.error?.message || `GPT request failed (${response.status}).`;
            throw new Error(message);
        }

        this.clearConnectTimeout();
        const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
        const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
        this.accumulatedText = text;
        this.emit('final', { text, stopReason: choice?.finish_reason || 'completed' });
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

    async listModels() {
        if (!this.apiKey) {
            throw new Error('GPT API key is not configured.');
        }
        const response = await fetch(new URL(MODELS_PATH, this.baseUrl).toString(), {
            method: 'GET',
            headers: this.buildHeaders(),
            signal: this.abortController?.signal
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch GPT models (${response.status}).`);
        }
        const data = await response.json();
        const items = Array.isArray(data?.data) ? data.data : [];
        return items
            .map((item) => {
                const id = typeof item?.id === 'string' ? item.id : '';
                if (!id) {
                    return null;
                }
                const name = typeof item?.name === 'string' && item.name.trim()
                    ? item.name.trim()
                    : id;
                return { id, name };
            })
            .filter(Boolean);
    }

    async testConnection() {
        try {
            await this.listModels();
            return { ok: true };
        } catch (error) {
            return {
                ok: false,
                error: error?.message || 'Unable to connect to GPT provider.'
            };
        }
    }
}

module.exports = {
    GptClient,
    DEFAULT_BASE_URL
};
