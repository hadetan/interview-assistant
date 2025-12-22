const test = require('node:test');
const assert = require('node:assert/strict');

const { registerDesktopCaptureHandler } = require('../server/electron/ipc/desktop-capture');

test('registerDesktopCaptureHandler maps sources with defaults', async () => {
    const registered = {};
    const fakeIpcMain = {
        handle: (channel, handler) => {
            registered[channel] = handler;
        }
    };

    const fakeSources = [
        {
            id: 'screen-1',
            name: 'Screen 1',
            thumbnail: { toDataURL: () => 'data-screen' },
            display_id: 'display-1'
        },
        {
            id: 'window-1',
            name: 'Window 1',
            thumbnail: null,
            display_id: null
        }
    ];

    const fakeDesktopCapturer = {
        getSources: async (opts) => {
            assert.deepEqual(opts, {
                types: ['screen', 'window'],
                fetchWindowIcons: true,
                thumbnailSize: { width: 320, height: 200 }
            });
            return fakeSources;
        }
    };

    registerDesktopCaptureHandler({ ipcMain: fakeIpcMain, desktopCapturer: fakeDesktopCapturer });
    const handler = registered['desktop-capture:get-sources'];
    assert.ok(typeof handler === 'function');

    const result = await handler({}, {});
    assert.deepEqual(result, [
        { id: 'screen-1', name: 'Screen 1', thumbnail: 'data-screen', display_id: 'display-1' },
        { id: 'window-1', name: 'Window 1', thumbnail: null, display_id: null }
    ]);
});

test('registerDesktopCaptureHandler forwards custom options', async () => {
    const registered = {};
    const fakeIpcMain = {
        handle: (channel, handler) => {
            registered[channel] = handler;
        }
    };

    const fakeDesktopCapturer = {
        getSources: async (opts) => {
            assert.deepEqual(opts, {
                types: ['window'],
                fetchWindowIcons: false,
                thumbnailSize: { width: 100, height: 50 }
            });
            return [];
        }
    };

    registerDesktopCaptureHandler({ ipcMain: fakeIpcMain, desktopCapturer: fakeDesktopCapturer });
    const handler = registered['desktop-capture:get-sources'];
    assert.ok(typeof handler === 'function');

    const result = await handler({}, {
        types: ['window'],
        fetchWindowIcons: false,
        thumbnailSize: { width: 100, height: 50 }
    });
    assert.deepEqual(result, []);
});
