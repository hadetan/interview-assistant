const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseArgvFlags,
    isTruthyFlag,
    hasArgFlag,
    offModeActive,
    shouldDisableContentProtection
} = require('../electron/env');

test('parseArgvFlags normalizes and trims argv', () => {
    const flags = parseArgvFlags([' --No-Content-Protection ', 'Off', 'FOO', undefined, null]);
    assert.deepEqual(flags, ['--no-content-protection', 'off', 'foo', '', '']);
});

test('hasArgFlag matches normalized flags', () => {
    const flags = parseArgvFlags(['--OFF', 'Extra']);
    assert.equal(hasArgFlag(flags, '--off'), true);
    assert.equal(hasArgFlag(flags, '--missing'), false);
});

test('offModeActive respects env and argv flags', () => {
    const baseFlags = parseArgvFlags(['--other']);
    assert.equal(offModeActive({ OFF: '0' }, baseFlags), false);
    assert.equal(offModeActive({}, parseArgvFlags(['--off'])), true);
    assert.equal(offModeActive({ OFF: 'true' }, baseFlags), true);
});

test('shouldDisableContentProtection toggles with env and flags', () => {
    const defaultFlags = parseArgvFlags([]);
    assert.equal(shouldDisableContentProtection({}, defaultFlags), false);
    assert.equal(shouldDisableContentProtection({}, parseArgvFlags(['off'])), true);
    assert.equal(shouldDisableContentProtection({ NO_CONTENT_PROTECTION: 'yes' }, defaultFlags), true);
    assert.equal(shouldDisableContentProtection({}, parseArgvFlags(['--no-content-protection'])), true);
});

test('isTruthyFlag accepts common true shapes', () => {
    assert.equal(isTruthyFlag('1'), true);
    assert.equal(isTruthyFlag('false'), false);
    assert.equal(isTruthyFlag(''), false);
    assert.equal(isTruthyFlag(undefined), false);
});
