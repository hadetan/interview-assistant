const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChunkMeta } = require('../ai/transcription/streaming/packetizer');

test('buildChunkMeta clones and fills defaults', () => {
    const meta = buildChunkMeta(null, 5, 1234);
    assert.equal(meta.sequence, 5);
    assert.equal(meta.segmentProducedTs, 1234);
    assert.equal(meta.converterProducedTs, undefined);
});

test('buildChunkMeta mutates lastChunkMeta for converterProducedTs', () => {
    const last = { sequence: 9, captureTs: 1000 };
    const result = buildChunkMeta(last, 9, 2000);
    assert.equal(last.converterProducedTs, 2000);
    assert.equal(result.sequence, 9);
    assert.equal(result.segmentProducedTs, 2000);
});
