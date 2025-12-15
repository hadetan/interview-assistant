const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { OllamaClient } = require('./providers/ollama-client');

const PROVIDER_FACTORIES = {
    ollama: (config = {}) => new OllamaClient(config)
};

class AssistantService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.provider = null;
        this.activeSession = null;
    }

    async init() {
        this.provider = this.createProvider();
        if (!this.provider) {
            throw new Error('Assistant provider could not be initialized.');
        }
    }

    createProvider() {
        const providerName = (this.config.provider || 'ollama').toLowerCase();
        const factory = PROVIDER_FACTORIES[providerName];
        if (!factory) {
            throw new Error(`Assistant provider "${providerName}" is not supported.`);
        }
        const providerConfig = this.config.providerConfig?.[providerName] || {};
        return factory(providerConfig);
    }

    async sendMessage({ sessionId, text }) {
        if (!this.provider) {
            throw new Error('Assistant provider is not ready.');
        }
        if (this.activeSession) {
            throw new Error('Assistant is already processing a request.');
        }

        const prompt = typeof text === 'string' ? text.trim() : '';
        if (!prompt) {
            throw new Error('Assistant prompt cannot be empty.');
        }

        const resolvedSessionId = sessionId || randomUUID();
        const messageId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const provider = this.provider;
        const detachListeners = this.attachProviderListeners(provider, resolvedSessionId, messageId);

        this.activeSession = {
            sessionId: resolvedSessionId,
            messageId,
            detachListeners
        };

        try {
            await provider.startStream({
                prompt,
                model: this.config.model
            });
        } catch (error) {
            detachListeners();
            this.activeSession = null;
            throw error;
        }

        process.nextTick(() => {
            this.emit('session-started', { sessionId: resolvedSessionId, messageId });
        });

        return { sessionId: resolvedSessionId, messageId };
    }

    attachProviderListeners(provider, sessionId, messageId) {
        const handlePartial = (payload = {}) => {
            this.emit('session-update', {
                sessionId,
                messageId,
                delta: typeof payload.delta === 'string' ? payload.delta : '',
                text: typeof payload.text === 'string' ? payload.text : undefined,
                isFinal: false
            });
        };

        const handleFinal = (payload = {}) => {
            this.emit('session-update', {
                sessionId,
                messageId,
                delta: typeof payload.delta === 'string' ? payload.delta : '',
                text: typeof payload.text === 'string' ? payload.text : undefined,
                isFinal: true
            });
            this.finishSession('completed', { stopReason: payload.stopReason || 'completed' });
        };

        const handleError = (error) => {
            const message = error instanceof Error ? error.message : String(error || 'Unknown assistant error');
            this.emit('session-error', {
                sessionId,
                messageId,
                error: { message }
            });
            this.finishSession('error', { error: { message } });
        };

        provider.on('partial', handlePartial);
        provider.on('final', handleFinal);
        provider.on('error', handleError);

        return () => {
            provider.off('partial', handlePartial);
            provider.off('final', handleFinal);
            provider.off('error', handleError);
        };
    }

    async cancelSession(targetSessionId) {
        const active = this.activeSession;
        if (!active) {
            return;
        }
        if (targetSessionId && targetSessionId !== active.sessionId) {
            return;
        }

        try {
            await this.provider.cancel();
        } catch (error) {
            console.warn('[AssistantService] Failed to cancel provider stream', error);
        }
        this.finishSession('cancelled');
    }

    finishSession(reason, detail = {}) {
        const active = this.activeSession;
        if (!active) {
            return;
        }
        if (typeof active.detachListeners === 'function') {
            active.detachListeners();
        }
        this.activeSession = null;
        this.emit('session-stopped', {
            sessionId: active.sessionId,
            messageId: active.messageId,
            reason,
            ...detail
        });
    }
}

module.exports = {
    AssistantService
};
