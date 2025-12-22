const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LiveStreamingSession } = require('../server/ai/transcription/streaming/live-session');


test('LiveStreamingSession respects VAD decisions when forwarding PCM', () => {
    class StubClient extends EventEmitter {
        constructor() {
            super();
            this.connected = false;
            this.sent = [];
        }

        async connect() {
            this.connected = true;
        }

        async disconnect() {
            this.connected = false;
        }

        isReady() {
            return this.connected;
        }

        sendAudio(buffer, meta) {
            if (!this.connected) {
                return false;
            }
            this.sent.push({ buffer, meta });
            this.emit('chunk-sent', { wsSendTs: Date.now(), ...meta });
            return true;
        }

        sendKeepalive() {
            return true;
        }
    }

    const stubClient = new StubClient();
    const session = new LiveStreamingSession({
        sessionId: 'session-test',
        sourceName: 'unit-test',
        client: stubClient,
        streamingConfig: {
            maxPendingChunkMs: 50,
            vad: {
                enabled: true,
                frameMs: 30,
                aggressiveness: 2,
                minSpeechRatio: 0.2,
                speechHoldMs: 200,
                silenceHoldMs: 200
            }
        },
        converterFactory: () => ({ start() {}, stop() {}, push() {} })
    });

    stubClient.connected = true;
    session.vadInstance = {};
    let callCount = 0;
    session.evaluateVadDecision = () => {
        callCount += 1;
        if (callCount === 1) {
            return {
                shouldSend: false,
                audioSpeech: false,
                holdActive: false,
                speechRatio: 0,
                frameCount: 10,
                speechFrames: 0,
                silenceAccumMs: 100
            };
        }
        return {
            shouldSend: true,
            audioSpeech: true,
            holdActive: false,
            speechRatio: 0.9,
            frameCount: 10,
            speechFrames: 9,
            silenceAccumMs: 0
        };
    };

    const pcm = Buffer.alloc(3200);
    const suppressed = session.processReadyChunk(pcm, { sequence: 1, captureTs: Date.now() });
    assert.equal(suppressed, false);
    assert.equal(stubClient.sent.length, 0);
    assert.equal(session.metrics.vadSuppressedChunks, 1);

    const forwarded = session.processReadyChunk(pcm, { sequence: 2, captureTs: Date.now() });
    assert.equal(forwarded, true);
    assert.equal(stubClient.sent.length, 1);
    assert.equal(session.metrics.vadSentChunks, 1);
});
