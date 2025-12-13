const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { MockStreamingClient } = require('../transcription/streaming/mock-client');

test('MockStreamingClient connects, sends, and emits transcription periodically', async () => {
    const client = new MockStreamingClient();
    assert.equal(client.isReady(), false);

    await client.connect();
    assert.equal(client.isReady(), true);

    await client.sendAudio(Buffer.from([0, 0]));
    await client.sendAudio(Buffer.from([0, 0]));

    const transcriptionPromise = once(client, 'transcription');
    await client.sendAudio(Buffer.from([0, 0]));
    const [payload] = await transcriptionPromise;
    assert.ok(payload.text.startsWith('mock transcript'));

    await client.disconnect();
    assert.equal(client.isReady(), false);
});
