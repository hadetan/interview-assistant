const test = require('node:test');
const assert = require('node:assert/strict');

const {
    clampNumber,
    sleep,
    analyzePcmChunk,
    computeChunkDurationMs,
    computeLatencyBreakdown
} = require('../transcription/streaming/helpers');

test('clampNumber clamps and handles non-numeric', () => {
    assert.equal(clampNumber(5, 0, 10), 5);
    assert.equal(clampNumber(-5, 0, 10), 0);
    assert.equal(clampNumber(50, 0, 10), 10);
    assert.equal(clampNumber(Number.NaN, 1, 3), 1);
});

test('sleep waits at least the requested duration', async () => {
    const start = Date.now();
    await sleep(15);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 15);
});

test('analyzePcmChunk computes rms and peak', () => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt16LE(1000, 0);
    buffer.writeInt16LE(-1000, 2);
    const stats = analyzePcmChunk(buffer);
    assert.equal(stats.peak, 1000);
    assert.ok(Math.abs(stats.rms - 1000) < 1e-6);
});

test('computeChunkDurationMs returns duration for 16k mono PCM', () => {
    const buf = Buffer.alloc(3200); // 1600 samples -> 100ms
    const duration = computeChunkDurationMs(buf);
    assert.equal(duration, 100);
    assert.equal(computeChunkDurationMs(Buffer.alloc(0)), 0);
});

test('computeLatencyBreakdown reports monotonic segments', () => {
    const now = Date.now();
    const info = {
        captureTs: now - 100,
        ipcTs: now - 80,
        serviceReceivedTs: now - 60,
        converterProducedTs: now - 40,
        wsSendTs: now - 20
    };
    const breakdown = computeLatencyBreakdown(info);
    assert.ok(breakdown);
    assert.equal(breakdown.captureToIpc, 20);
    assert.equal(breakdown.ipcToService, 20);
    assert.equal(breakdown.serviceToConverter, 20);
    assert.equal(breakdown.converterToWs, 20);
    assert.ok(breakdown.wsToTranscript >= 0);
    assert.ok(breakdown.total >= 100);
});
