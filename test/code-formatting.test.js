const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const jsdom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = jsdom.window;
global.document = jsdom.window.document;

global.HTMLElement = jsdom.window.HTMLElement;
global.Node = jsdom.window.Node;

global.self = jsdom.window;

global.navigator = jsdom.window.navigator;

const parseModulePromise = import('../src/utils/parseFencedCode.js');
const highlightModulePromise = import('../src/utils/highlightCode.js');

test('parseFencedCode identifies text and code segments', async () => {
    const { parseFencedCode } = await parseModulePromise;
    const sample = "Intro text\n```js\nconsole.log('hi');\n```\nClosing.";
    const segments = parseFencedCode(sample);
    assert.equal(segments.length, 3);
    assert.deepEqual(segments[0], { type: 'text', text: 'Intro text\n' });
    assert.equal(segments[1].type, 'code');
    assert.equal(segments[1].language, 'js');
    assert.equal(segments[2].text.trim(), 'Closing.');
});

test('parseFencedCode handles multiple blocks and dangling fence warning', async () => {
    const { parseFencedCode } = await parseModulePromise;
    const sample = "Text\n```py\nprint('a')\n```\nMore text\n```go\nfmt.Println('b')\n```\nDangling start\n```ts\nconst a = 1;";
    const segments = parseFencedCode(sample);
    const codeSegments = segments.filter((seg) => seg.type === 'code');
    const errorSegments = segments.filter((seg) => seg.type === 'error');
    assert.equal(codeSegments.length, 2);
    assert.equal(codeSegments[0].language, 'py');
    assert.equal(codeSegments[1].language, 'go');
    assert.equal(errorSegments.length, 1);
    assert.match(errorSegments[0].text, /unclosed/i);
});

test('highlightCode honors explicit language hints', async () => {
    const { highlightCode } = await highlightModulePromise;
    const result = highlightCode('console.log("hello")', 'javascript');
    assert.equal(result.language, 'javascript');
    assert.match(result.html, /hljs/);
});

test('highlightCode sanitizes script tags within code fences', async () => {
    const { highlightCode } = await highlightModulePromise;
    const snippet = "<script>alert('pwned')</script>";
    const { html } = highlightCode(snippet, 'html');
    assert.ok(!html.includes('<script'));
    assert.ok(html.includes('&lt;'));
    assert.ok(html.toLowerCase().includes('script'));
});
