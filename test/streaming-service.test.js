const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { StreamingTranscriptionService } = require('../transcription/streaming/streaming-service');

test('StreamingTranscriptionService starts session, receives update, and stops', async () => {
    const service = new StreamingTranscriptionService({
        providerConfig: { assembly: { apiKey: 'test-key' } },
        streaming: {
            mock: true,
            silenceFillMs: 0,
            maxPendingChunkMs: 50
        }
    });

    await service.init();

    const converterFactory = () => {
        return {
            start: () => {},
            stop: () => {},
            push: (buffer) => {
                // Immediately emit onData shape expected by LiveStreamingSession
                // Note: LiveStreamingSession aggregates and sends via client
            }
        };
    };

    const sessionId = await service.startSession({ sourceName: 'svc-test', converterFactory });

    const updatePromise = once(service, 'session-update');

    const buffer = Buffer.alloc(4000);
    service.pushChunk(sessionId, {
        buffer,
        sequence: 1,
        captureTimestamp: Date.now()
    });

    const [update] = await updatePromise;
    assert.equal(update.sessionId, sessionId);
    assert.ok(typeof update.text === 'string');

    await service.stopSession(sessionId);
    assert.equal(service.sessions.size, 0);
});
