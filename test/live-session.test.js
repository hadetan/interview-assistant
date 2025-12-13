const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { LiveStreamingSession } = require('../transcription/streaming/live-session');
const { MockStreamingClient } = require('../transcription/streaming/mock-client');

const makeFakeConverterFactory = () => {
    let started = false;
    let stopped = false;
    return {
        factory: (options) => ({
            start: () => {
                started = true;
            },
            stop: () => {
                stopped = true;
            },
            push: (buffer) => {
                // Immediately emit converted PCM back into the session
                options.onData(buffer, { producedAt: Date.now() });
            }
        }),
        get started() { return started; },
        get stopped() { return stopped; }
    };
};

test('LiveStreamingSession processes chunks and emits update', async () => {
    const client = new MockStreamingClient();
    const converter = makeFakeConverterFactory();
    const session = new LiveStreamingSession({
        sessionId: 'sess-1',
        sourceName: 'test-source',
        client,
        streamingConfig: {
            silenceFillMs: 100000, // avoid filler noise during test
            maxPendingChunkMs: 50
        },
        converterFactory: converter.factory
    });

    await session.start();
    assert.equal(converter.started, true);

    const finalUpdatePromise = new Promise((resolve) => {
        const handler = (payload) => {
            if (payload?.isFinal) {
                session.off('update', handler);
                resolve(payload);
            }
        };
        session.on('update', handler);
    });

    const buffer = Buffer.alloc(4000); // > TARGET_CHUNK_SIZE to force flush
    session.addChunk({ buffer, sequence: 1, captureTimestamp: Date.now() });
    session.addChunk({ buffer, sequence: 2, captureTimestamp: Date.now() });
    session.addChunk({ buffer, sequence: 3, captureTimestamp: Date.now() });

    const payload = await finalUpdatePromise;
    assert.ok(payload.text.includes('mock transcript'));
    assert.equal(payload.isFinal, true);

    await session.stop();
    assert.equal(converter.stopped, true);
    assert.equal(session.terminated, true);
});
