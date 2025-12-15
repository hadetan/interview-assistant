const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveTranscriptText,
    initialTranscriptText
} = require('../src/utils/transcriptText');

test('resolveTranscriptText appends delta when provided', () => {
    const current = 'hello';
    const delta = ' world';
    assert.equal(resolveTranscriptText(current, { delta }), 'hello world');
});

test('resolveTranscriptText prefers server text when no delta', () => {
    const current = 'partial text';
    const serverText = 'authoritative complete text';
    assert.equal(resolveTranscriptText(current, { serverText }), serverText);
});

test('initialTranscriptText prefers server text then delta', () => {
    assert.equal(initialTranscriptText({ serverText: 'full' }), 'full');
    assert.equal(initialTranscriptText({ delta: 'piece' }), 'piece');
    assert.equal(initialTranscriptText({}), '');
});
