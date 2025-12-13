const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSilenceFrame } = require('../transcription/streaming/silence-filler');

test('buildSilenceFrame creates zeroed buffer of correct length', () => {
    const buf = buildSilenceFrame(null, 100); // 100ms at 16k mono -> 1600 samples -> 3200 bytes
    assert.equal(buf.length, 3200);
    for (let i = 0; i < buf.length; i += 1) {
        assert.equal(buf[i], 0);
    }
});

test('buildSilenceFrame reuses existing buffer when size matches', () => {
    const initial = buildSilenceFrame(null, 50);
    const reused = buildSilenceFrame(initial, 50);
    assert.strictEqual(reused, initial);
});
