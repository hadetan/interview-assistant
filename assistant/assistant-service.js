const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { OllamaClient } = require('./providers/ollama-client');
const { AnthropicClient } = require('./providers/anthropic-client');

const PROVIDER_FACTORIES = {
    ollama: (config = {}) => new OllamaClient(config),
    anthropic: (config = {}) => new AnthropicClient(config)
};

class AssistantService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.provider = null;
        this.activeSession = null;
        this.drafts = new Map();
    }

    async init() {
        this.provider = this.createProvider();
        if (!this.provider) {
            throw new Error('Assistant provider could not be initialized.');
        }
    }

    createProvider() {
        if (this.config && this.config.isEnabled === false) {
            throw new Error('Assistant provider is disabled due to missing configuration.');
        }

        const providerName = (this.config.provider || 'ollama').toLowerCase();
        const factory = PROVIDER_FACTORIES[providerName];
        if (!factory) {
            throw new Error(`Assistant provider "${providerName}" is not supported.`);
        }
        const providerConfig = this.config.providerConfig?.[providerName] || {};
        return factory(providerConfig);
    }

    async attachImage({ draftId, image }) {
        if (!image || !image.data || !image.mime) {
            throw new Error('Image attachment must include mime and base64 data.');
        }

        const sanitized = {
            id: image.id || `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: image.name || 'capture.png',
            mime: image.mime,
            data: image.data
        };

        const targetId = draftId || randomUUID();
        const existing = this.drafts.get(targetId) || { id: targetId, attachments: [] };
        existing.attachments.push(sanitized);
        this.drafts.set(targetId, existing);

        return {
            draftId: targetId,
            attachments: existing.attachments.map(({ id, name, mime }) => ({ id, name, mime }))
        };
    }

    async finalizeDraft({ sessionId, draftId, messages = [], codeOnly = false }) {
        if (!this.provider) {
            throw new Error('Assistant provider is not ready.');
        }
        if (this.activeSession) {
            throw new Error('Assistant is already processing a request.');
        }

        const { attachments, consumedDraftId } = this.consumeDraft(draftId);
        const textContent = this.combineUserText(messages);
        const hasText = Boolean(textContent);
        const hasImages = attachments.length > 0;

        if (!hasText && !hasImages) {
            throw new Error('No pending content to send to the assistant.');
        }

        const { systemPrompt, userPrompt, stream } = this.buildPrompts({ hasImages, textContent, codeOnly });
        const { messagePayload, promptText } = this.buildProviderPayload({ attachments, userPrompt, systemPrompt, hasImages, textContent, codeOnly });

        const resolvedSessionId = sessionId || randomUUID();
        const messageId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const provider = this.provider;
        const detachListeners = this.attachProviderListeners(provider, resolvedSessionId, messageId);

        this.activeSession = {
            sessionId: resolvedSessionId,
            messageId,
            detachListeners,
            draftId: consumedDraftId
        };

        try {
            if (messagePayload) {
                await provider.startStream(messagePayload);
            } else {
                await provider.startStream({ prompt: promptText, model: this.config.model, stream });
            }
        } catch (error) {
            detachListeners();
            this.activeSession = null;
            throw error;
        }

        process.nextTick(() => {
            this.emit('session-started', { sessionId: resolvedSessionId, messageId, draftId: consumedDraftId });
        });

        return { sessionId: resolvedSessionId, messageId, draftId: consumedDraftId };
    }

    async sendMessage({ sessionId, text }) {
        const prompt = typeof text === 'string' ? text.trim() : '';
        if (!prompt) {
            throw new Error('Assistant prompt cannot be empty.');
        }
        return this.finalizeDraft({ sessionId, messages: [{ text: prompt }], codeOnly: false, draftId: null });
    }

    combineUserText(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return '';
        }
        const pieces = messages
            .map((msg) => (typeof msg?.text === 'string' ? msg.text.trim() : ''))
            .filter(Boolean);
        return pieces.join('\n');
    }

    consumeDraft(draftId) {
        if (draftId && this.drafts.has(draftId)) {
            const draft = this.drafts.get(draftId);
            this.drafts.delete(draftId);
            return { attachments: draft.attachments || [], consumedDraftId: draftId };
        }
        // If no id provided, consume the most recent draft if present
        const iterator = Array.from(this.drafts.values());
        const latest = iterator.at(-1);
        if (latest) {
            this.drafts.delete(latest.id);
            return { attachments: latest.attachments || [], consumedDraftId: latest.id };
        }
        return { attachments: [], consumedDraftId: null };
    }

    discardDraft({ draftId, discardAll = false } = {}) {
        if (discardAll) {
            const discarded = this.drafts.size;
            this.drafts.clear();
            return { discarded };
        }
        if (!draftId) {
            return { discarded: 0 };
        }
        const existed = this.drafts.delete(draftId);
        return { discarded: existed ? 1 : 0 };
    }

    buildPrompts({ hasImages, textContent, codeOnly }) {
        const systemPrompt = hasImages ? this.config.systemPrompts?.imageMode : this.config.systemPrompts?.textMode;
        const hasText = Boolean(textContent);
        const userPrompt = hasText
            ? textContent
            : (hasImages ? this.config.userPrompts?.imageDefault : '');

        const stream = !hasImages; // image-first flows are single-response
        const appliedPrompt = codeOnly && userPrompt
            ? `${userPrompt}\n\n(If code is required, return only code.)`
            : userPrompt;

        return { systemPrompt: systemPrompt || '', userPrompt: appliedPrompt || '', stream };
    }

    buildProviderPayload({ attachments, userPrompt, systemPrompt, hasImages, textContent, codeOnly }) {
        const providerName = (this.config.provider || 'ollama').toLowerCase();
        if (providerName === 'ollama') {
            if (hasImages) {
                throw new Error('Current provider does not support image requests.');
            }
            const promptText = `${systemPrompt ? `${systemPrompt}\n\n` : ''}${userPrompt}`.trim();
            return { messagePayload: null, promptText, stream: true };
        }

        if (providerName === 'anthropic') {
            const content = [];
            for (const attachment of attachments) {
                content.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: attachment.mime,
                        data: attachment.data
                    }
                });
            }
            if (userPrompt) {
                content.push({ type: 'text', text: userPrompt });
            }
            const messages = content.length ? [{ role: 'user', content }] : [];
            const stream = !hasImages;
            return {
                promptText: null,
                messagePayload: {
                    messages,
                    systemPrompt,
                    model: this.config.model,
                    stream,
                    maxTokens: this.config.providerConfig?.anthropic?.maxOutputTokens
                }
            };
        }

        throw new Error(`Assistant provider "${providerName}" is not supported for this request.`);
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
