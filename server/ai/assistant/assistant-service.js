const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { OllamaClient } = require('./providers/ollama-client');
const { AnthropicClient } = require('./providers/anthropic-client');
const { GptClient } = require('./providers/gpt-client');

const PROVIDER_FACTORIES = {
    ollama: (config = {}) => new OllamaClient(config),
    anthropic: (config = {}) => new AnthropicClient(config),
    gpt: (config = {}) => new GptClient(config)
};

class AssistantService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.provider = null;
        this.activeSession = null;
        this.drafts = new Map();
        this.conversations = new Map();
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

    ensureConversation(conversationId) {
        if (!conversationId) {
            throw new Error('Conversation identifier is required.');
        }
        let record = this.conversations.get(conversationId);
        if (!record) {
            record = {
                id: conversationId,
                turns: [],
                seenTurnIds: new Set()
            };
            this.conversations.set(conversationId, record);
        }
        return record;
    }

    getConversationHistory(conversationId) {
        if (!conversationId) {
            return [];
        }
        const record = this.conversations.get(conversationId);
        return record ? record.turns : [];
    }

    appendConversationTurns(conversationId, turns = []) {
        if (!conversationId || !Array.isArray(turns) || turns.length === 0) {
            return;
        }
        const record = this.ensureConversation(conversationId);
        for (const turn of turns) {
            if (!turn || typeof turn.id !== 'string' || record.seenTurnIds.has(turn.id)) {
                continue;
            }
            const normalizedMessage = typeof turn.message === 'string' ? turn.message : '';
            if (!normalizedMessage) {
                continue;
            }
            const messageBy = turn.messageBy === 'assistant'
                ? 'assistant'
                : (turn.messageBy === 'user' ? 'user' : 'interviewer');
            const timestamp = Number.isFinite(turn.ts) ? turn.ts : Date.now();
            record.turns.push({
                id: turn.id,
                messageBy,
                message: normalizedMessage,
                ts: timestamp
            });
            record.seenTurnIds.add(turn.id);
        }
    }

    async clearConversation({ conversationId, discardDrafts = true } = {}) {
        if (!conversationId) {
            return { cleared: false };
        }
        if (this.activeSession?.conversationId === conversationId) {
            await this.cancelSession(this.activeSession.sessionId);
        }
        const existed = this.conversations.delete(conversationId);
        if (discardDrafts) {
            for (const [draftKey, draft] of Array.from(this.drafts.entries())) {
                if (!draft?.conversationId || draft.conversationId === conversationId) {
                    this.drafts.delete(draftKey);
                }
            }
        }
        return { cleared: existed };
    }

    async attachImage({ draftId, image, conversationId }) {
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
        const existing = this.drafts.get(targetId) || { id: targetId, attachments: [], conversationId: conversationId || null };
        if (conversationId && !existing.conversationId) {
            existing.conversationId = conversationId;
        }
        existing.attachments.push(sanitized);
        this.drafts.set(targetId, existing);

        return {
            draftId: targetId,
            attachments: existing.attachments.map(({ id, name, mime }) => ({ id, name, mime }))
        };
    }

    async finalizeDraft({ sessionId, draftId, messages = [], codeOnly = false, conversationId }) {
        if (!this.provider) {
            throw new Error('Assistant provider is not ready.');
        }
        if (this.activeSession) {
            throw new Error('Assistant is already processing a request.');
        }

        const transcriptMessages = this.normalizeTranscriptMessages(messages);
        const {
            attachments,
            consumedDraftId,
            draftConversationId
        } = this.consumeDraft(draftId);

        let resolvedConversationId = typeof conversationId === 'string' && conversationId.length > 0
            ? conversationId
            : (draftConversationId || null);
        if (!resolvedConversationId) {
            resolvedConversationId = randomUUID();
        }

        const conversationRecord = this.ensureConversation(resolvedConversationId);
        const existingHistory = conversationRecord.turns.map(({ id, messageBy, message }) => ({ id, messageBy, message }));

        const baseTimestamp = Date.now();
        const pendingTurns = transcriptMessages
            .filter((msg) => !conversationRecord.seenTurnIds.has(msg.id))
            .map((msg, index) => ({
                id: msg.id,
                messageBy: msg.messageBy,
                message: msg.message,
                ts: baseTimestamp + index
            }));

        const hasTranscriptContext = pendingTurns.length > 0;
        const hasImages = attachments.length > 0;

        if (!hasTranscriptContext && !hasImages) {
            throw new Error('No pending content to send to the assistant.');
        }

        const newMessagesForPrompt = pendingTurns.map(({ id, messageBy, message }) => ({ id, messageBy, message }));

        const { systemPrompt, userPrompt, stream } = this.buildPrompts({
            hasImages,
            conversationHistory: existingHistory,
            newMessages: newMessagesForPrompt,
            codeOnly
        });
        const { messagePayload, promptText } = this.buildProviderPayload({
            attachments,
            userPrompt,
            systemPrompt,
            hasImages,
            stream
        });

        const resolvedSessionId = sessionId || randomUUID();
        const messageId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const provider = this.provider;
        const detachListeners = this.attachProviderListeners(provider, resolvedSessionId, messageId, resolvedConversationId);

        this.activeSession = {
            sessionId: resolvedSessionId,
            messageId,
            detachListeners,
            draftId: consumedDraftId,
            conversationId: resolvedConversationId
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

        this.appendConversationTurns(resolvedConversationId, pendingTurns);

        process.nextTick(() => {
            this.emit('session-started', {
                sessionId: resolvedSessionId,
                messageId,
                draftId: consumedDraftId,
                conversationId: resolvedConversationId
            });
        });

        return {
            sessionId: resolvedSessionId,
            messageId,
            draftId: consumedDraftId,
            conversationId: resolvedConversationId
        };
    }

    async sendMessage({ sessionId, text, conversationId }) {
        const prompt = typeof text === 'string' ? text.trim() : '';
        if (!prompt) {
            throw new Error('Assistant prompt cannot be empty.');
        }
        const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        return this.finalizeDraft({
            sessionId,
            messages: [{ id: messageId, messageBy: 'user', message: prompt }],
            codeOnly: false,
            draftId: null,
            conversationId
        });
    }

    normalizeTranscriptMessages(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return [];
        }
        const result = [];
        for (const item of messages) {
            const message = typeof item?.message === 'string' ? item.message : '';
            if (!message) {
                continue;
            }
            const messageBy = item?.messageBy === 'user' ? 'user' : 'interviewer';
            const id = typeof item?.id === 'string' && item.id.length > 0
                ? item.id
                : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            result.push({ id, messageBy, message });
        }
        return result;
    }

    consumeDraft(draftId) {
        if (draftId && this.drafts.has(draftId)) {
            const draft = this.drafts.get(draftId);
            this.drafts.delete(draftId);
            return {
                attachments: draft.attachments || [],
                consumedDraftId: draftId,
                draftConversationId: draft.conversationId || null
            };
        }
        // If no id provided, consume the most recent draft if present
        const iterator = Array.from(this.drafts.values());
        const latest = iterator.at(-1);
        if (latest) {
            this.drafts.delete(latest.id);
            return {
                attachments: latest.attachments || [],
                consumedDraftId: latest.id,
                draftConversationId: latest.conversationId || null
            };
        }
        return { attachments: [], consumedDraftId: null, draftConversationId: null };
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

    buildPrompts({ hasImages, conversationHistory = [], newMessages = [], codeOnly }) {
        const systemPrompt = hasImages
            ? this.config.systemPrompts?.imageMode
            : this.config.systemPrompts?.textMode;

        const safeHistory = Array.isArray(conversationHistory)
            ? conversationHistory.map(({ id, messageBy, message }) => ({ id, messageBy, message }))
            : [];
        const safeMessages = Array.isArray(newMessages)
            ? newMessages.map(({ id, messageBy, message }) => ({ id, messageBy, message }))
            : [];

        const historyJson = JSON.stringify({ history: safeHistory }, null, 2);
        const latestJson = JSON.stringify({ messages: safeMessages }, null, 2);

        const historyBlock = `Conversation history (chronological JSON):\n${historyJson}`;
        const latestBlock = `Latest transcript entries (chronological JSON):\n${latestJson}`;

        const policyLines = [
            'Review the entire history in order; treat each object as immutable source material.',
            'Treat entries with messageBy "assistant" as your prior replies and stay consistent with them unless corrections are required.',
            'If any interviewer entry contains a new question, answer it directly using both the stored history and the latest transcript before referencing images.',
            'Only rely on the image attachment(s) when the latest transcript lacks an actionable interviewer question.',
            'When both history and images lack actionable requests, reply exactly with "No response returned. Context lacked clarity".'
        ];

        if (codeOnly) {
            policyLines.push('When you produce code, output only the final code without commentary.');
        }

        const imageContextLine = hasImages
            ? 'Image context: attachment(s) are available; use them only if the transcript provides no interview question to answer.'
            : 'Image context: none provided.';

        const userPrompt = [
            historyBlock,
            '',
            latestBlock,
            '',
            'Speakers: "interviewer" = system transcript, "user" = microphone transcript, "assistant" = your earlier replies.',
            imageContextLine,
            '',
            'Response policy:',
            policyLines.map((line) => `- ${line}`).join('\n')
        ].join('\n');

        const stream = !hasImages; // image-first flows are single-response

        return { systemPrompt: systemPrompt || '', userPrompt, stream };
    }

    buildProviderPayload({ attachments, userPrompt, systemPrompt, hasImages, stream }) {
        const providerName = (this.config.provider || 'ollama').toLowerCase();
        if (providerName === 'ollama') {
            if (hasImages) {
                throw new Error('Current provider does not support image requests.');
            }
            const promptText = `${systemPrompt ? `${systemPrompt}\n\n` : ''}${userPrompt}`.trim();
            return { messagePayload: null, promptText, stream };
        }

        if (providerName === 'anthropic') {
            const content = [];
            if (userPrompt) {
                content.push({ type: 'text', text: userPrompt });
            }
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
            const messages = content.length ? [{ role: 'user', content }] : [];
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

    attachProviderListeners(provider, sessionId, messageId, conversationId) {
        const handlePartial = (payload = {}) => {
            this.emit('session-update', {
                sessionId,
                messageId,
                conversationId,
                delta: typeof payload.delta === 'string' ? payload.delta : '',
                text: typeof payload.text === 'string' ? payload.text : undefined,
                isFinal: false
            });
        };

        const handleFinal = (payload = {}) => {
            const finalText = typeof payload.text === 'string' ? payload.text : undefined;
            if (conversationId && typeof finalText === 'string' && finalText.length > 0) {
                this.appendConversationTurns(conversationId, [{
                    id: messageId,
                    messageBy: 'assistant',
                    message: finalText,
                    ts: Date.now()
                }]);
            }
            this.emit('session-update', {
                sessionId,
                messageId,
                conversationId,
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
                conversationId,
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
        const conversationId = active.conversationId;
        if (typeof active.detachListeners === 'function') {
            active.detachListeners();
        }
        this.activeSession = null;
        this.emit('session-stopped', {
            sessionId: active.sessionId,
            messageId: active.messageId,
             conversationId,
            reason,
            ...detail
        });
    }
}

module.exports = {
    AssistantService
};
