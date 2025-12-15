const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeText } = require('../src/utils/mergeText');

test('mergeText returns base when incoming empty', () => {
    assert.equal(mergeText('hello', ''), 'hello');
});

test('mergeText prefers incoming when it already contains base segment', () => {
    assert.equal(mergeText('hello wor', 'hello world'), 'hello world');
});

test('mergeText avoids duplicating trailing overlap', () => {
    assert.equal(mergeText('hello wor', 'world!'), 'hello world!');
});

test('mergeText keeps punctuation tight', () => {
    assert.equal(mergeText('Finished', '. Done.'), 'Finished. Done.');
});

test('mergeText preserves base when it already ends with incoming', () => {
    assert.equal(mergeText('hello world', 'world'), 'hello world');
});

test('mergeText keeps earlier words when incoming only has tail', () => {
    const base = 'The quick brown fox jumps';
    const incoming = 'fox jumps over the lazy dog';
    assert.equal(mergeText(base, incoming), 'The quick brown fox jumps over the lazy dog');
});

test('mergeText preserves whitespace-only deltas when appending', () => {
    const withSpace = mergeText('what', ' ', true);
    assert.equal(withSpace, 'what ');
    assert.equal(mergeText(withSpace, 'the', true), 'what the');
});
