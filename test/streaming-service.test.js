const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { StreamingTranscriptionService } = require('../server/ai/transcription/streaming/streaming-service');
const { DeepgramLiveClient } = require('../server/ai/transcription/streaming/providers/deepgram-client');

test('StreamingTranscriptionService starts session, receives update, and stops', async () => {
    const service = new StreamingTranscriptionService({
        providerConfig: { assembly: { apiKey: 'test-key' } },
        streaming: {
            mock: true,
            maxPendingChunkMs: 50
        }
    });

    await service.init();

    const converterFactory = (options) => {
        return {
            start: () => {},
            stop: () => {},
            push: (buffer) => {
                options.onData(buffer, { producedAt: Date.now() });
            }
        };
    };

    const sessionId = await service.startSession({ sourceName: 'svc-test', converterFactory });

    const updatePromise = new Promise((resolve) => {
        const handler = (update) => {
            if (update?.isFinal) {
                service.off('session-update', handler);
                resolve(update);
            }
        };
        service.on('session-update', handler);
    });

    const buffer = Buffer.alloc(4000);
    for (let i = 0; i < buffer.length; i += 2) {
        buffer.writeInt16LE(6000, i);
    }
    for (let seq = 1; seq <= 3; seq += 1) {
        service.pushChunk(sessionId, {
            buffer,
            sequence: seq,
            captureTimestamp: Date.now()
        });
    }

    const update = await updatePromise;
    assert.equal(update.sessionId, sessionId);
    assert.ok(typeof update.text === 'string');
    assert.equal(update.isFinal, true);

    await service.stopSession(sessionId);
    assert.equal(service.sessions.size, 0);
});

test('StreamingTranscriptionService creates Deepgram client when configured', async () => {
    const service = new StreamingTranscriptionService({
        provider: 'deepgram',
        providerConfig: { deepgram: { apiKey: 'dg-test-key' } },
        streaming: {
            deepgramParams: {
                model: 'nova-3',
                sample_rate: 16000
            }
        }
    });

    await service.init();
    const client = service.createClient();
    assert.ok(client instanceof DeepgramLiveClient);
});
