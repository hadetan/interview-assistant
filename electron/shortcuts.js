const createShortcutManager = ({ globalShortcut }) => {
    const registry = new Map();

    const registerShortcut = (accelerator, handler) => {
        registry.set(accelerator, handler);

        try {
            const ok = globalShortcut.register(accelerator, handler);
            if (!ok) {
                console.warn(`[Shortcut] Failed to register ${accelerator} accelerator.`);
            } else {
                console.log(`[Shortcut] Registered ${accelerator} accelerator.`);
            }
            return ok;
        } catch (err) {
            console.warn(`[Shortcut] Failed to register ${accelerator}`, err);
            return false;
        }
    };

    const registerAllShortcuts = () => {
        for (const [accelerator, handler] of registry.entries()) {
            try {
                if (!globalShortcut.isRegistered(accelerator)) {
                    const ok = globalShortcut.register(accelerator, handler);
                    if (!ok) {
                        console.warn(`[Shortcut] Failed to register ${accelerator} accelerator.`);
                    } else {
                        console.log(`[Shortcut] Registered ${accelerator} accelerator.`);
                    }
                }
            } catch (err) {
                console.warn(`[Shortcut] Failed to register ${accelerator}`, err);
            }
        }
    };

    const unregisterAllShortcutsExcept = (allowedSet = new Set()) => {
        for (const accelerator of registry.keys()) {
            if (allowedSet.has(accelerator)) {
                continue;
            }
            try {
                if (globalShortcut.isRegistered(accelerator)) {
                    globalShortcut.unregister(accelerator);
                    console.log(`[Shortcut] Unregistered ${accelerator} accelerator.`);
                }
            } catch (err) {
                console.warn(`[Shortcut] Failed to unregister ${accelerator}`, err);
            }
        }
    };

    return {
        registerShortcut,
        registerAllShortcuts,
        unregisterAllShortcutsExcept,
        getRegisteredShortcuts: () => new Map(registry)
    };
};

module.exports = { createShortcutManager };
