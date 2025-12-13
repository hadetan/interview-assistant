const test = require('node:test');
const assert = require('node:assert/strict');

const { createShortcutManager } = require('../electron/shortcuts');

test('shortcut manager registers and unregisters accelerators', () => {
    const registry = new Set();
    const calls = [];
    const fakeGlobalShortcut = {
        register: (accelerator, handler) => {
            registry.add(accelerator);
            calls.push(['register', accelerator]);
            // immediately invoke handler once for test coverage
            handler();
            return true;
        },
        unregister: (accelerator) => {
            registry.delete(accelerator);
            calls.push(['unregister', accelerator]);
        },
        isRegistered: (accelerator) => registry.has(accelerator)
    };

    const manager = createShortcutManager({ globalShortcut: fakeGlobalShortcut });
    let ran = 0;
    manager.registerShortcut('CmdOrCtrl+1', () => { ran += 1; });
    assert.equal(ran, 1);
    assert.ok(registry.has('CmdOrCtrl+1'));

    manager.unregisterAllShortcutsExcept(new Set(['CmdOrCtrl+1']));
    assert.ok(registry.has('CmdOrCtrl+1'));

    manager.unregisterAllShortcutsExcept(new Set());
    assert.ok(!registry.has('CmdOrCtrl+1'));

    manager.registerShortcut('CmdOrCtrl+2', () => {});
    registry.delete('CmdOrCtrl+2');
    manager.registerAllShortcuts();
    assert.ok(registry.has('CmdOrCtrl+2'));
    assert.deepEqual(calls.filter((c) => c[0] === 'register').map((c) => c[1]).includes('CmdOrCtrl+2'), true);
});
