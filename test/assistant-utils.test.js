const test = require('node:test');
const assert = require('node:assert/strict');

const { EventEmitter } = require('node:events');
const assistantModulePromise = import('../src/utils/assistantMessage.js');
const attachmentModulePromise = import('../src/utils/attachmentPreview.js');
const { AssistantService } = require('../server/ai/assistant/assistant-service');

class FakeProvider extends EventEmitter {
    constructor() {
        super();
        this.startedPayloads = [];
    }

    async startStream(payload = {}) {
        this.startedPayloads.push(payload);
        setTimeout(() => {
            this.emit('final', { text: 'done', stopReason: 'completed' });
        }, 0);
        return { ok: true };
    }

    async cancel() {
        return { ok: true };
    }
}

test('mergeAssistantText keeps placeholder until content arrives', async () => {
    const { mergeAssistantText } = await assistantModulePromise;
    const result = mergeAssistantText('Thinking...', { delta: '', serverText: undefined });
    assert.equal(result.text, 'Thinking...');
    assert.equal(result.didUpdate, false);
});

test('mergeAssistantText replaces placeholder when delta arrives', async () => {
    const { mergeAssistantText } = await assistantModulePromise;
    const result = mergeAssistantText('Thinking...', { delta: 'return value', serverText: undefined });
    assert.equal(result.text, 'return value');
    assert.equal(result.didUpdate, true);
});

test('buildAttachmentPreview produces data URL using metadata', async () => {
    const { buildAttachmentPreview } = await attachmentModulePromise;
    const preview = buildAttachmentPreview({
        image: { data: 'YWJj', mime: 'image/jpeg', name: 'raw' },
        metadata: { id: 'img-123', name: 'capture-1' }
    });
    assert.equal(preview.id, 'img-123');
    assert.equal(preview.name, 'capture-1');
    assert.equal(preview.mime, 'image/jpeg');
    assert.equal(preview.dataUrl, 'data:image/jpeg;base64,YWJj');
});

test('mergeAttachmentPreviews deduplicates by id and keeps latest data', async () => {
    const { mergeAttachmentPreviews } = await attachmentModulePromise;
    const existing = [
        { id: 'img-1', dataUrl: 'data:image/png;base64,AAA' }
    ];
    const incoming = [
        { id: 'img-2', dataUrl: 'data:image/png;base64,BBB' },
        { id: 'img-1', dataUrl: 'data:image/png;base64,UPDATED' }
    ];
    const merged = mergeAttachmentPreviews(existing, incoming);
    assert.equal(merged.length, 2);
    const updated = merged.find((item) => item.id === 'img-1');
    assert.ok(updated);
    assert.equal(updated.dataUrl, 'data:image/png;base64,UPDATED');
});

test('AssistantService discardDraft removes targeted draft', () => {
    const service = new AssistantService({ provider: 'ollama', providerConfig: { ollama: {} }, model: 'test-model' });
    service.drafts.set('draft-1', { id: 'draft-1', attachments: [{ id: 'img-a' }] });
    service.drafts.set('draft-2', { id: 'draft-2', attachments: [{ id: 'img-b' }] });
    const result = service.discardDraft({ draftId: 'draft-1' });
    assert.equal(result.discarded, 1);
    assert.equal(service.drafts.has('draft-1'), false);
    assert.equal(service.drafts.size, 1);
});

test('AssistantService discardDraft clears all drafts when requested', () => {
    const service = new AssistantService({ provider: 'ollama', providerConfig: { ollama: {} }, model: 'test-model' });
    service.drafts.set('draft-1', { id: 'draft-1', attachments: [] });
    service.drafts.set('draft-2', { id: 'draft-2', attachments: [] });
    const result = service.discardDraft({ discardAll: true });
    assert.equal(result.discarded, 2);
    assert.equal(service.drafts.size, 0);
});

test('AssistantService finalizeDraft stores turns and returns conversationId', async () => {
    const service = new AssistantService({
        provider: 'anthropic',
        providerConfig: { anthropic: { maxOutputTokens: 512 } },
        model: 'fake-model',
        systemPrompts: {
            textMode: 'SYSTEM-TEXT',
            imageMode: 'SYSTEM-IMAGE'
        }
    });
    service.createProvider = () => new FakeProvider();
    await service.init();

    const stopPromise = new Promise((resolve) => {
        service.once('session-stopped', resolve);
    });

    const result = await service.finalizeDraft({
        messages: [
            { id: 'turn-1', messageBy: 'interviewer', message: 'How are you?' },
            { id: 'turn-2', messageBy: 'user', message: "I am doing well." }
        ]
    });

    assert.equal(typeof result.conversationId, 'string');

    await stopPromise;

    const payload = service.provider.startedPayloads.at(-1);
    assert.ok(Array.isArray(payload.messages));
    const textBlock = payload.messages[0].content.find((item) => item.type === 'text');
    assert.ok(textBlock);
    assert.match(textBlock.text, /Conversation history \(chronological JSON\):/);
    assert.match(textBlock.text, /Latest transcript entries \(chronological JSON\):/);
    assert.match(textBlock.text, /"messageBy": "interviewer"/);
    assert.match(textBlock.text, /"messageBy": "user"/);

    const history = service.getConversationHistory(result.conversationId);
    assert.equal(history.length, 3);
    const assistantTurn = history.find((turn) => turn.messageBy === 'assistant');
    assert.ok(assistantTurn);
    assert.equal(assistantTurn.message, 'done');
});

test('AssistantService finalizeDraft reuses conversation history for follow-ups', async () => {
    const service = new AssistantService({
        provider: 'anthropic',
        providerConfig: { anthropic: { maxOutputTokens: 512 } },
        model: 'fake-model',
        systemPrompts: {
            textMode: 'SYSTEM-TEXT',
            imageMode: 'SYSTEM-IMAGE'
        }
    });
    service.createProvider = () => new FakeProvider();
    await service.init();

    let stopPromise = new Promise((resolve) => service.once('session-stopped', resolve));
    const first = await service.finalizeDraft({
        messages: [
            { id: 'intro-1', messageBy: 'interviewer', message: 'Explain merge sort.' }
        ]
    });
    await stopPromise;

    stopPromise = new Promise((resolve) => service.once('session-stopped', resolve));
    await service.finalizeDraft({
        conversationId: first.conversationId,
        messages: [
            { id: 'follow-1', messageBy: 'user', message: 'It divides the array recursively.' },
            { id: 'follow-2', messageBy: 'interviewer', message: 'What is the complexity?' }
        ]
    });
    await stopPromise;

    const payload = service.provider.startedPayloads.at(-1);
    const textBlock = payload.messages[0].content.find((item) => item.type === 'text');
    assert.ok(textBlock);
    assert.match(textBlock.text, /"messageBy": "assistant"/);
    assert.match(textBlock.text, /"id": "follow-2"/);

    const history = service.getConversationHistory(first.conversationId);
    const assistantTurns = history.filter((turn) => turn.messageBy === 'assistant');
    assert.ok(assistantTurns.length >= 2);
    assert.ok(history.some((turn) => turn.id === 'follow-2'));
});

test('AssistantService finalizeDraft preserves image context when transcript absent', async () => {
    const service = new AssistantService({
        provider: 'anthropic',
        providerConfig: { anthropic: { maxOutputTokens: 256 } },
        model: 'fake-model',
        systemPrompts: {
            textMode: 'SYSTEM-TEXT',
            imageMode: 'SYSTEM-IMAGE'
        }
    });
    service.createProvider = () => new FakeProvider();
    await service.init();

    const { draftId } = await service.attachImage({
        image: { id: 'img-1', mime: 'image/png', data: 'AAA' },
        conversationId: 'image-convo'
    });

    const stopPromise = new Promise((resolve) => {
        service.once('session-stopped', resolve);
    });

    await service.finalizeDraft({
        draftId,
        messages: [],
        conversationId: 'image-convo'
    });

    await stopPromise;

    const payload = service.provider.startedPayloads.at(-1);
    assert.equal(payload.stream, false);
    const content = payload.messages[0].content;
    const textBlock = content.find((item) => item.type === 'text');
    assert.ok(textBlock);
    assert.match(textBlock.text, /Image context: attachment\(s\) are available/);
    const imageBlock = content.find((item) => item.type === 'image');
    assert.ok(imageBlock);
    assert.equal(imageBlock.source.media_type, 'image/png');
});

test('AssistantService finalizeDraft rejects when no transcripts or images remain', async () => {
    const service = new AssistantService({
        provider: 'anthropic',
        providerConfig: { anthropic: { maxOutputTokens: 128 } },
        model: 'fake-model',
        systemPrompts: {
            textMode: 'SYS',
            imageMode: 'SYS-IMG'
        }
    });
    service.createProvider = () => new FakeProvider();
    await service.init();

    await assert.rejects(
        () => service.finalizeDraft({ messages: [], draftId: null }),
        /No pending content/
    );
});

test('AssistantService clearConversation removes history and drafts', async () => {
    const service = new AssistantService({
        provider: 'anthropic',
        providerConfig: { anthropic: { maxOutputTokens: 256 } },
        model: 'fake-model',
        systemPrompts: {
            textMode: 'SYS',
            imageMode: 'SYS-IMG'
        }
    });
    service.createProvider = () => new FakeProvider();
    await service.init();

    const stopPromise = new Promise((resolve) => service.once('session-stopped', resolve));
    const first = await service.finalizeDraft({
        messages: [
            { id: 'clear-1', messageBy: 'interviewer', message: 'State your name.' }
        ]
    });
    await stopPromise;

    await service.attachImage({
        image: { id: 'clear-img', mime: 'image/png', data: 'BBQ=' },
        conversationId: first.conversationId,
        draftId: 'clear-draft'
    });

    const result = await service.clearConversation({ conversationId: first.conversationId });
    assert.ok(result.cleared);
    assert.equal(service.getConversationHistory(first.conversationId).length, 0);
    for (const draft of service.drafts.values()) {
        assert.notEqual(draft.conversationId, first.conversationId);
    }
});
