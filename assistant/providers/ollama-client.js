const { EventEmitter } = require('node:events');
const { TextDecoder } = require('node:util');

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5-coder:1.5b';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

class OllamaClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
        this.defaultModel = options.model || DEFAULT_MODEL;
        this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
            ? options.requestTimeoutMs
            : DEFAULT_TIMEOUT_MS;
        this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs)
            ? options.connectTimeoutMs
            : DEFAULT_CONNECT_TIMEOUT_MS;
        this.abortController = null;
        this.streamPromise = null;
        this.timeoutId = null;
        this.connectTimeoutId = null;
        this.accumulatedText = '';
    }

    async startStream({ prompt, model } = {}) {
        if (this.streamPromise) {
            throw new Error('Assistant request already in progress.');
        }

        const text = typeof prompt === 'string' ? prompt.trim() : '';
        if (!text) {
            throw new Error('Assistant prompt must be a non-empty string.');
        }

        const resolvedModel = (model || this.defaultModel || '').trim();
        if (!resolvedModel) {
            throw new Error('Assistant model is not configured.');
        }

        this.accumulatedText = '';
        this.abortController = new AbortController();

        const payload = {
            model: resolvedModel,
            prompt: text,
            stream: true
        };

        const requestOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: this.abortController.signal
        };

        this.installTimeouts();

        let response;
        try {
            response = await fetch(`${this.baseUrl}/api/generate`, requestOptions);
        } catch (error) {
            this.clearState();
            throw new Error(`Assistant request failed to reach Ollama: ${error.message}`);
        }

        if (!response.ok) {
            this.clearState();
            const reason = await this.safeReadBody(response).catch(() => null);
            throw new Error(reason || `Assistant request failed (${response.status})`);
        }

        if (!response.body || typeof response.body.getReader !== 'function') {
            this.clearState();
            throw new Error('Assistant response stream is unavailable.');
        }

        this.streamPromise = this.consumeStream(response.body)
            .catch((error) => {
                if (error?.name === 'AbortError') {
                    return;
                }
                this.emit('error', error instanceof Error ? error : new Error(String(error)));
            })
            .finally(() => {
                this.clearState();
            });

        return { ok: true };
    }

    async cancel() {
        if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
        }
        this.clearState();
        try {
            await this.streamPromise;
        } catch (_error) {
            // ignore cancellation errors
        }
    }

    installTimeouts() {
        this.clearTimeouts();
        if (this.requestTimeoutMs > 0) {
            this.timeoutId = setTimeout(() => {
                if (this.abortController && !this.abortController.signal.aborted) {
                    this.abortController.abort();
                }
                this.emit('error', new Error('Assistant request timed out.'));
            }, this.requestTimeoutMs);
        }
        if (this.connectTimeoutMs > 0) {
            this.connectTimeoutId = setTimeout(() => {
                if (this.abortController && !this.abortController.signal.aborted) {
                    this.abortController.abort();
                }
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

    clearState() {
        this.clearTimeouts();
        this.streamPromise = null;
        this.abortController = null;
        this.accumulatedText = '';
    }

    async safeReadBody(response) {
        try {
            return await response.text();
        } catch (_error) {
            return null;
        }
    }

    async consumeStream(stream) {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalEmitted = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (this.connectTimeoutId) {
                clearTimeout(this.connectTimeoutId);
                this.connectTimeoutId = null;
            }
            if (value) {
                buffer += decoder.decode(value, { stream: true });
                const result = this.processBuffer(buffer);
                buffer = result.buffer;
                finalEmitted = finalEmitted || result.finalEmitted;
            }
        }

        const trailing = decoder.decode();
        const finalResult = this.processBuffer(buffer + trailing, true);
        finalEmitted = finalEmitted || finalResult.finalEmitted;
        if (!finalEmitted) {
            this.emit('final', {
                text: this.accumulatedText,
                stopReason: 'completed'
            });
        }
    }

    processBuffer(buffer, flush = false) {
        let remaining = buffer;
        let newlineIndex = remaining.indexOf('\n');
        let finalEmitted = false;

        while (newlineIndex !== -1) {
            const line = remaining.slice(0, newlineIndex).trim();
            remaining = remaining.slice(newlineIndex + 1);
            finalEmitted = this.processLine(line) || finalEmitted;
            newlineIndex = remaining.indexOf('\n');
        }

        if (flush && remaining.trim().length > 0) {
            finalEmitted = this.processLine(remaining.trim()) || finalEmitted;
            return { buffer: '', finalEmitted };
        }

        return { buffer: remaining, finalEmitted };
    }

    processLine(line) {
        if (!line) {
            return false;
        }

        let payload;
        try {
            payload = JSON.parse(line);
        } catch (error) {
            this.emit('error', new Error(`Assistant payload parse failure: ${error.message}`));
            return false;
        }

        if (payload.error) {
            this.emit('error', new Error(payload.error));
            return false;
        }

        if (typeof payload.response === 'string' && payload.response.length > 0) {
            const delta = this.appendWithSpacing(payload.response);
            if (delta) {
                this.emit('partial', {
                    delta,
                    text: this.accumulatedText
                });
            }
        }

        if (payload.done) {
            const reason = payload.done_reason || 'completed';
            this.emit('final', {
                text: this.accumulatedText,
                stopReason: reason
            });
            return true;
        }

        return false;
    }

    appendWithSpacing(chunk) {
        const raw = chunk;
        if (!raw) {
            return '';
        }
        const previous = this.accumulatedText || '';
        let normalized = raw;
        const needsLeadingSpace = Boolean(previous)
            && !/\s$/.test(previous)
            && !/^\s/.test(raw);
        if (needsLeadingSpace) {
            normalized = ` ${raw}`;
        } else if (!previous) {
            normalized = raw.replace(/^\s+/, '');
        }
        this.accumulatedText = `${previous}${normalized}`;
        return normalized;
    }
}

module.exports = {
    OllamaClient
};
