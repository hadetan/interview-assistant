const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { StreamingTranscriptionService } = require('../ai/transcription/streaming/streaming-service');

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
