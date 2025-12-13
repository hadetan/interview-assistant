const test = require('node:test');
const assert = require('node:assert/strict');

const { registerTranscriptionHandlers, normalizeChunkBuffer } = require('../electron/ipc/transcription');

test('normalizeChunkBuffer handles ArrayBuffer and views', () => {
    const arr = new Uint8Array([1, 2, 3]);
    const buf = normalizeChunkBuffer(arr);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.length, 3);
});

test('transcription handlers start, drop oversized chunks, and stop sessions', async () => {
    const handlers = {};
    const fakeIpcMain = {
        handle: (channel, fn) => { handlers[channel] = fn; },
        on: (channel, fn) => { handlers[channel] = fn; }
    };

    const pushed = [];
    let stopped = false;
    const service = {
        startSession: async () => 'sess-1',
        stopSession: async () => { stopped = true; },
        pushChunk: (sessionId, payload) => pushed.push({ sessionId, payload })
    };

    const sessionWindowMap = new Map();
    const fakeWindow = { id: 99, webContents: { send: () => {} }, once: () => {} };
    const fakeBrowserWindow = {
        fromWebContents: () => fakeWindow,
        fromId: () => fakeWindow
    };

    const transcriptionConfig = { streaming: { maxChunkBytes: 4 } };

    registerTranscriptionHandlers({
        ipcMain: fakeIpcMain,
        BrowserWindow: fakeBrowserWindow,
        ensureTranscriptionService: async () => service,
        getTranscriptionService: () => service,
        transcriptionConfig,
        sessionWindowMap
    });

    const startResult = await handlers['transcription:start']({ sender: {} }, { sessionId: 'abc', sourceName: 'source' });
    assert.equal(startResult.sessionId, 'sess-1');
    assert.equal(sessionWindowMap.get('sess-1'), 99);

    await handlers['transcription:chunk']({}, { sessionId: 'sess-1', data: Buffer.alloc(10) });
    assert.equal(pushed.length, 0);

    await handlers['transcription:chunk']({}, { sessionId: 'sess-1', data: Buffer.alloc(2), sequence: 3, captureTimestamp: 5 });
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].sessionId, 'sess-1');
    assert.equal(pushed[0].payload.sequence, 3);

    const stopResult = await handlers['transcription:stop']({}, { sessionId: 'sess-1' });
    assert.equal(stopResult.ok, true);
    assert.equal(stopped, true);
    assert.equal(sessionWindowMap.has('sess-1'), false);
});
