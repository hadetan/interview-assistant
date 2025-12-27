const test = require('node:test');
const assert = require('node:assert/strict');

const { createWindowManager, clampOverlaysWithinArea } = require('../server/electron/window-manager');

class FakeBrowserWindow {
    static nextId = 1;

    constructor(opts = {}) {
        this.id = FakeBrowserWindow.nextId++;
        this.opts = opts;
        this._bounds = { x: 0, y: 0, width: opts.width || 100, height: opts.height || 50 };
        this._contentSize = [this._bounds.width, this._bounds.height];
        this._events = new Map();
        this.webContents = {
            send: () => {},
            on: () => {}
        };
    }

    loadFile() {}
    loadURL() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setFullScreenable() {}
    setIgnoreMouseEvents() {}
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    setPosition(x, y) { this._bounds.x = x; this._bounds.y = y; }
    setContentSize(width, height) {
        this._contentSize = [width, height];
        this._bounds.width = width;
        this._bounds.height = height;
    }
    getContentSize() { return [...this._contentSize]; }
    getBounds() { return { ...this._bounds }; }
    on(name, handler) { this._events.set(name, handler); }
    once(name, handler) { this._events.set(name, handler); }
    isDestroyed() { return false; }
}

const fakeScreen = {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 1200 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 1200 } })
};

const fakeNativeImage = { createFromPath: () => ({}) };

const fsModule = { existsSync: () => false };

const pathModule = require('node:path');

const fakeApp = { quit: () => {} };

test('clampOverlaysWithinArea keeps overlays within bounds', () => {
    const workArea = { x: 0, y: 0, width: 100, height: 100 };
    const targets = [
        { x: -5, y: 10, width: 10, height: 20 },
        { x: 80, y: 60, width: 10, height: 20 }
    ];

    const [clampedA, clampedB] = clampOverlaysWithinArea(targets, workArea);
    assert.ok(clampedA.x >= 0);
    assert.ok(clampedB.x + clampedB.width <= workArea.width);
});

test('moveOverlaysBy repositions overlays and clamps to the work area', () => {
    const windowManager = createWindowManager({
        BrowserWindow: FakeBrowserWindow,
        screen: fakeScreen,
        nativeImage: fakeNativeImage,
        pathModule,
        fsModule,
        stealthModeEnabled: false,
        contentProtectionEnabledByDefault: true,
        moveStepPx: 200,
        app: fakeApp
    });

    const transcript = windowManager.createTranscriptWindow();

    transcript.setPosition(100, 100);

    windowManager.moveOverlaysBy(600, 600);
    const transcriptBounds = transcript.getBounds();

    assert.ok(transcriptBounds.x >= 0 && transcriptBounds.x + transcriptBounds.width <= 1200);
    assert.ok(transcriptBounds.y >= 0 && transcriptBounds.y + transcriptBounds.height <= 1200);
});
