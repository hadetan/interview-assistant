const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, nativeImage, systemPreferences, shell } = require('electron');
const loadTranscriptionConfig = require('../config/transcription');
const loadAssistantConfig = require('../config/assistant');
const { createTranscriptionService } = require('../ai/transcription');
const { createAssistantService } = require('../ai/assistant');
const {
    loadEnv,
    parseArgvFlags,
    offModeActive: computeOffModeActive,
    shouldDisableContentProtection: computeDisableContentProtection
} = require('./env');
const { registerDesktopCaptureHandler } = require('./ipc/desktop-capture');
const { createWindowManager } = require('./window-manager');
const { createShortcutManager } = require('./shortcuts');
const { registerTranscriptionHandlers } = require('./ipc/transcription');
const { registerAssistantHandlers } = require('./ipc/assistant');
const { createSecureStore } = require('./secure-store');
const { createSettingsStore } = require('./settings-store');
const { registerSettingsHandlers } = require('./ipc/settings');
const { createAuthStore } = require('./auth-store');
const { registerAuthHandlers } = require('./ipc/auth');
const { createPermissionManager } = require('./permissions');
const { registerPermissionHandlers } = require('./ipc/permissions');

loadEnv();

const AUTH_DEEP_LINK_PROTOCOL = 'capture';
const pendingDeepLinkUrls = [];
let flushDeepLinkQueue = null;

const enqueueDeepLinkUrl = (url) => {
    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (!trimmed) {
        return;
    }
    pendingDeepLinkUrls.push(trimmed);
    if (typeof flushDeepLinkQueue === 'function') {
        flushDeepLinkQueue();
    }
};

const findDeepLinkArg = (argv = []) => {
    if (!Array.isArray(argv)) {
        return '';
    }
    for (const arg of argv) {
        if (typeof arg !== 'string') {
            continue;
        }
        if (arg.toLowerCase().startsWith(`${AUTH_DEEP_LINK_PROTOCOL}:`)) {
            return arg;
        }
    }
    return '';
};

const parseParams = (searchParams) => {
    const result = {};
    if (!searchParams) {
        return result;
    }
    for (const [key, value] of searchParams.entries()) {
        result[key] = value;
    }
    return result;
};

const parseOAuthCallbackUrl = (urlString) => {
    const trimmed = typeof urlString === 'string' ? urlString.trim() : '';
    if (!trimmed) {
        return null;
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (_error) {
        return null;
    }
    if (parsed.protocol !== `${AUTH_DEEP_LINK_PROTOCOL}:`) {
        return null;
    }
    const params = parseParams(parsed.searchParams);
    const fragmentRaw = parsed.hash || '';
    const fragmentString = fragmentRaw.startsWith('#') ? fragmentRaw.slice(1) : fragmentRaw;
    const fragmentParams = parseParams(new URLSearchParams(fragmentString));
    return {
        url: trimmed,
        host: parsed.host || '',
        pathname: parsed.pathname || '',
        params,
        fragmentParams,
        code: params.code || fragmentParams.code || '',
        state: params.state || fragmentParams.state || '',
        error: params.error || fragmentParams.error || '',
        errorDescription: params.error_description || fragmentParams.error_description || '',
        fragment: fragmentRaw,
        receivedAt: new Date().toISOString()
    };
};

if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

app.on('second-instance', (_event, argv = []) => {
    const deepLink = findDeepLinkArg(argv);
    if (deepLink) {
        enqueueDeepLinkUrl(deepLink);
    }
});

app.on('will-finish-launching', () => {
    app.on('open-url', (event, url) => {
        event.preventDefault();
        enqueueDeepLinkUrl(url);
    });
});

const initialDeepLink = findDeepLinkArg(process.argv);
if (initialDeepLink) {
    enqueueDeepLinkUrl(initialDeepLink);
}

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

// Enable desktop audio capture on macOS
if (process.platform === 'darwin') {
    app.commandLine.appendSwitch('enable-features', 'ScreenCaptureKitMac');
    app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
}

let transcriptionService = null;
let transcriptionInitPromise = null;
let transcriptionConfig = null;
const sessionWindowMap = new Map();
const activeTranscriptionSessions = new Set();
let assistantService = null;
let assistantInitPromise = null;
let assistantConfig = null;
const assistantSessionWindowMap = new Map();
let secureStore = null;
let settingsStore = null;
let authStore = null;

const MOVE_STEP_PX = 200;

const argvFlags = parseArgvFlags();
const offModeActive = computeOffModeActive(process.env, argvFlags);
const contentProtectionEnabledByDefault = !computeDisableContentProtection(process.env, argvFlags);
const stealthModeEnabled = !offModeActive;

const applyContentProtection = (targetWindow) => {
    if (!targetWindow?.setContentProtection) {
        console.warn('[ContentProtection] setContentProtection is unavailable on this platform.');
        return;
    }

    try {
        targetWindow.setContentProtection(contentProtectionEnabledByDefault);
        const reportedState = typeof targetWindow.isContentProtected === 'function'
            ? targetWindow.isContentProtected()
            : 'unknown';
        console.log(
            `[ContentProtection] Applied ${contentProtectionEnabledByDefault ? 'ENABLED' : 'DISABLED'} to window #${targetWindow.id} (reported: ${reportedState}).`
        );
    } catch (error) {
        console.warn('[ContentProtection] Failed to set content protection on window', error);
    }
};

console.log(
    `[ContentProtection] Default state: ${contentProtectionEnabledByDefault ? 'ENABLED' : 'DISABLED'} (OFF flag ${contentProtectionEnabledByDefault ? 'not detected' : 'detected'}).`
);

console.log(
    `[Overlay] Stealth mode ${stealthModeEnabled ? 'ENABLED' : 'DISABLED'} (OFF flag ${offModeActive ? 'detected' : 'not detected'}).`
);

app.on('browser-window-created', (_event, window) => {
    applyContentProtection(window);
});

const windowManager = createWindowManager({
    BrowserWindow,
    screen,
    nativeImage,
    pathModule: path,
    fsModule: fs,
    stealthModeEnabled,
    contentProtectionEnabledByDefault,
    moveStepPx: MOVE_STEP_PX,
    app
});

const shortcutManager = createShortcutManager({ globalShortcut });
const permissionManager = createPermissionManager({ systemPreferences, platform: process.platform });

const ensureTranscriptionService = async () => {
    if (transcriptionInitPromise) {
        try {
            await transcriptionInitPromise;
        } catch (error) {
            console.error('[Transcription] Initialization failed', error);
        }
    }

    if (!transcriptionService) {
        throw new Error('Transcription service is unavailable.');
    }

    return transcriptionService;
};

const ensureAssistantService = async () => {
    if (assistantInitPromise) {
        try {
            await assistantInitPromise;
        } catch (error) {
            console.error('[Assistant] Initialization failed', error);
        }
    }

    if (!assistantService) {
        throw new Error('Assistant service is unavailable.');
    }

    return assistantService;
};

const buildAssistantConfigFromSettings = async () => {
    if (!settingsStore || !secureStore) {
        return loadAssistantConfig({});
    }
    const stored = settingsStore.getAssistantSettings();
    const provider = typeof stored.provider === 'string' ? stored.provider : '';
    const model = typeof stored.model === 'string' ? stored.model : '';
    const providerConfig = stored.providerConfig || {};
    const apiKey = provider ? await secureStore.getAssistantApiKey(provider) || '' : '';
    return loadAssistantConfig({ provider, model, apiKey, providerConfig });
};

const attachAssistantServiceListeners = (service) => {
    const emitToOwner = (sessionId, payload) => {
        const windowId = assistantSessionWindowMap.get(sessionId);
        if (!windowId) {
            return;
        }
        const targetWindow = BrowserWindow.fromId(windowId);
        if (!targetWindow || targetWindow.isDestroyed()) {
            return;
        }
        targetWindow.webContents.send('assistant:stream', payload);
    };

    service.on('session-started', ({ sessionId, messageId }) => {
        emitToOwner(sessionId, { type: 'started', sessionId, messageId });
    });

    service.on('session-update', (payload) => {
        emitToOwner(payload.sessionId, { type: 'update', ...payload });
    });

    service.on('session-error', (payload) => {
        emitToOwner(payload.sessionId, { type: 'error', ...payload });
    });

    service.on('session-stopped', (payload) => {
        emitToOwner(payload.sessionId, { type: 'stopped', ...payload });
        assistantSessionWindowMap.delete(payload.sessionId);
    });
};

const teardownAssistantService = async () => {
    if (!assistantService) {
        assistantInitPromise = null;
        return;
    }

    try {
        await assistantService.cancelSession();
    } catch (error) {
        console.warn('[Assistant] Failed to cancel active session during teardown', error);
    }

    try {
        assistantService.removeAllListeners?.();
    } catch (error) {
        console.warn('[Assistant] Failed to clear listeners during teardown', error);
    }

    assistantService = null;
    assistantInitPromise = null;
    assistantSessionWindowMap.clear();
};

const synchronizeAssistantConfiguration = async () => {
    const config = await buildAssistantConfigFromSettings();
    assistantConfig = config;

    if (!config.isEnabled) {
        await teardownAssistantService();
        return config;
    }

    await teardownAssistantService();

    assistantInitPromise = createAssistantService(config)
        .then((service) => {
            assistantService = service;
            attachAssistantServiceListeners(service);
            return service;
        })
        .catch((error) => {
            console.error('[Assistant] Failed to initialize service', error);
            assistantService = null;
            assistantInitPromise = null;
            return null;
        });

    return config;
};

const initializeApp = async () => {
    secureStore = secureStore || createSecureStore();
    settingsStore = settingsStore || createSettingsStore({ app });
    authStore = authStore || createAuthStore({ app });

    await synchronizeAssistantConfiguration();

    const {
        moveOverlaysBy,
        positionOverlayWindows,
        getTranscriptWindow,
        getSettingsWindow,
        getPermissionWindow,
        getAuthWindow,
        createTranscriptWindow,
        createSettingsWindow,
        createPermissionWindow,
        createAuthWindow,
        destroySettingsWindow,
        destroyPermissionWindow,
        destroyAuthWindow,
        sendPermissionStatus,
        moveStepPx,
        getPreviewWindow
    } = windowManager;

    const getActiveTranscriptWindow = () => {
        const transcript = getTranscriptWindow();
        if (!transcript || transcript.isDestroyed()) {
            return null;
        }
        return transcript;
    };

    const sendToTranscriptWindow = (channel, payload) => {
        const transcript = getActiveTranscriptWindow();
        if (!transcript) {
            return false;
        }
        try {
            transcript.webContents.send(channel, payload);
            return true;
        } catch (error) {
            console.warn(`[Overlay] Failed to send ${channel}`, error);
            return false;
        }
    };

    const isAssistantEnabled = () => assistantConfig?.isEnabled !== false;
    const assistantMissingPrerequisites = () => Boolean(
        assistantConfig?.missing?.provider ||
        assistantConfig?.missing?.model ||
        assistantConfig?.missing?.apiKey
    );

    const ensureSettingsWindowVisible = () => {
        const existing = getSettingsWindow();
        if (existing) {
            existing.focus();
            return existing;
        }
        return createSettingsWindow();
    };

    const isTranscriptionActive = () => activeTranscriptionSessions.size > 0;

    const ensureOverlayWindowsVisible = () => {
        if (!isAssistantEnabled()) {
            return false;
        }
        if (!getTranscriptWindow()) {
            createTranscriptWindow();
        }
        positionOverlayWindows();
        destroySettingsWindow();
        return true;
    };

    // macOS pre-flight: always show permission/testing window before overlays.
    let permissionPreflightComplete = permissionManager.isMac ? false : true;

    let emitPermissionStatus = () => { };

    const ensurePermissionWindowVisible = (status) => {
        const currentStatus = status || permissionManager.refreshStatus();
        destroySettingsWindow();
        createPermissionWindow();
        emitPermissionStatus(currentStatus);
        return getPermissionWindow();
    };

    const closePermissionWindow = () => {
        destroyPermissionWindow();
    };

    const showMainExperience = () => {
        if (assistantMissingPrerequisites()) {
            closePermissionWindow();
            ensureSettingsWindowVisible();
            return false;
        }

        if (!isAssistantEnabled()) {
            closePermissionWindow();
            ensureSettingsWindowVisible();
            return false;
        }

        if (permissionManager.isMac) {
            const status = permissionManager.refreshStatus();
            if (!permissionPreflightComplete) {
                ensurePermissionWindowVisible(status);
                return false;
            }
            if (!status.allGranted) {
                ensurePermissionWindowVisible(status);
                return false;
            }
        }

        closePermissionWindow();
        ensureOverlayWindowsVisible();
        return true;
    };

    let awaitingAuthentication = false;

    const ensureAuthWindowVisible = () => {
        awaitingAuthentication = true;
        return createAuthWindow();
    };

    const closeAuthWindowWithoutExit = () => {
        awaitingAuthentication = false;
        destroyAuthWindow({ exitApp: false });
    };

    const canShowMainExperience = () => {
        if (awaitingAuthentication) {
            return false;
        }
        return showMainExperience();
    };

    const permissionIpcRegistration = registerPermissionHandlers({
        ipcMain,
        permissionManager,
        sendPermissionStatus,
        onPermissionsGranted: () => {
            permissionPreflightComplete = true;
            if (canShowMainExperience()) {
                shortcutManager.registerAllShortcuts();
            }
        }
    });

    if (permissionIpcRegistration?.emitStatusToWindow) {
        emitPermissionStatus = permissionIpcRegistration.emitStatusToWindow;
    }

    const initialAccessToken = authStore.loadAccessToken();
    if (typeof initialAccessToken === 'string' && initialAccessToken.trim()) {
        awaitingAuthentication = false;
        if (canShowMainExperience()) {
            shortcutManager.registerAllShortcuts();
        }
    } else {
        ensureAuthWindowVisible();
    }

    const { emitOAuthCallback } = registerAuthHandlers({
        ipcMain,
        authStore,
        env: process.env,
        onTokenSet: ({ accessToken }) => {
            const sanitized = typeof accessToken === 'string' ? accessToken.trim() : '';
            if (!sanitized) {
                ensureAuthWindowVisible();
                return;
            }
            closeAuthWindowWithoutExit();
            if (canShowMainExperience()) {
                shortcutManager.registerAllShortcuts();
            }
        },
        onTokenCleared: () => {
            ensureAuthWindowVisible();
        },
        openExternal: (url) => shell.openExternal(url)
    });

    const registerAuthProtocol = () => {
        try {
            if (process.defaultApp && process.argv.length >= 2) {
                const appPath = path.resolve(process.argv[1]);
                const success = app.setAsDefaultProtocolClient(AUTH_DEEP_LINK_PROTOCOL, process.execPath, [appPath]);
                if (!success) {
                    console.warn(`[Auth] Failed to register ${AUTH_DEEP_LINK_PROTOCOL} protocol handler in development mode.`);
                }
                return;
            }
            const success = app.setAsDefaultProtocolClient(AUTH_DEEP_LINK_PROTOCOL);
            if (!success) {
                console.warn(`[Auth] Failed to register ${AUTH_DEEP_LINK_PROTOCOL} protocol handler.`);
            }
        } catch (error) {
            console.warn('[Auth] Protocol registration failed.', error);
        }
    };

    registerAuthProtocol();

    const handleDeepLinkUrl = (url) => {
        const trimmed = typeof url === 'string' ? url.trim() : '';
        if (!trimmed) {
            return;
        }

        let parsedUrl;
        try {
            parsedUrl = new URL(trimmed);
        } catch (_error) {
            console.warn('[Auth] Ignoring malformed deep link URL.');
            return;
        }

        if (parsedUrl.protocol !== `${AUTH_DEEP_LINK_PROTOCOL}:`) {
            console.warn(`[Auth] Ignoring unsupported deep link protocol: ${parsedUrl.protocol}`);
            return;
        }

        const payload = parseOAuthCallbackUrl(trimmed);
        if (!payload) {
            return;
        }
        if (awaitingAuthentication) {
            const existing = getAuthWindow();
            if (!existing) {
                ensureAuthWindowVisible();
            } else {
                try {
                    existing.focus();
                } catch (_error) {
                    // ignore focus failures
                }
            }
        }
        if (typeof emitOAuthCallback === 'function') {
            emitOAuthCallback(payload);
        }
    };

    flushDeepLinkQueue = () => {
        while (pendingDeepLinkUrls.length > 0) {
            const next = pendingDeepLinkUrls.shift();
            handleDeepLinkUrl(next);
        }
    };

    setImmediate(() => {
        if (typeof flushDeepLinkQueue === 'function') {
            flushDeepLinkQueue();
        }
    });

    registerSettingsHandlers({
        ipcMain,
        settingsStore,
        secureStore,
        windowManager,
        resolveAssistantConfig: buildAssistantConfigFromSettings,
        onSettingsApplied: async () => {
            const updatedConfig = await synchronizeAssistantConfiguration();
            if (updatedConfig && updatedConfig.isEnabled) {
                if (canShowMainExperience()) {
                    shortcutManager.registerAllShortcuts();
                }
            }
        },
        onGeneralSettingsApplied: async (generalSettings) => {
            const transcriptWindow = windowManager.getTranscriptWindow();
            if (transcriptWindow && !transcriptWindow.isDestroyed()) {
                try {
                    transcriptWindow.webContents.send('settings:general-updated', { general: generalSettings });
                } catch (error) {
                    console.warn('[Settings] Failed to notify transcript window about general settings update', error);
                }
            }
            const previewWindow = getPreviewWindow();
            if (previewWindow && !previewWindow.isDestroyed()) {
                try {
                    previewWindow.webContents.send('settings:general-updated', { general: generalSettings });
                } catch (error) {
                    console.warn('[Settings] Failed to notify preview window about general settings update', error);
                }
            }
        }
    });

    /* Start the app */
    const toggleShortcut = 'CommandOrControl+Shift+/';
    shortcutManager.registerShortcut(toggleShortcut, () => {
        if (!isAssistantEnabled()) {
            ensureSettingsWindowVisible();
            return;
        }
        if (!canShowMainExperience()) {
            return;
        }
        sendToTranscriptWindow('control-window:toggle-capture');
    });

    /* Scroll up and down in conversion */
    const scrollUpShortcut = 'CommandOrControl+Shift+Up';
    shortcutManager.registerShortcut(scrollUpShortcut, () => {
        sendToTranscriptWindow('control-window:scroll-up');
    });

    const scrollDownShortcut = 'CommandOrControl+Shift+Down';
    shortcutManager.registerShortcut(scrollDownShortcut, () => {
        sendToTranscriptWindow('control-window:scroll-down');
    });

    /* Clear conversation history */
    const clearTranscriptShortcut = 'CommandOrControl+Shift+G';
    shortcutManager.registerShortcut(clearTranscriptShortcut, () => {
        sendToTranscriptWindow('control-window:clear-transcript');
    });

    /* Turn mic on or off */
    const toggleMicShortcut = 'CommandOrControl+Shift+M';
    shortcutManager.registerShortcut(toggleMicShortcut, () => {
        sendToTranscriptWindow('control-window:toggle-mic');
    });

    const assistantShortcut = 'CommandOrControl+Enter';
    shortcutManager.registerShortcut(assistantShortcut, () => {
        if (!isAssistantEnabled()) {
            ensureSettingsWindowVisible();
            return;
        }
        sendToTranscriptWindow('control-window:assistant-send');
    });

    const attachImageShortcut = 'CommandOrControl+Shift+H';
    shortcutManager.registerShortcut(attachImageShortcut, async () => {
        if (!isAssistantEnabled()) {
            ensureSettingsWindowVisible();
            return;
        }
        const transcriptWindow = getActiveTranscriptWindow();
        if (!transcriptWindow) {
            return;
        }
        try {
            const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
            const source = sources[0];
            if (!source || !source.thumbnail) {
                throw new Error('No screen source available for capture.');
            }
            const buffer = source.thumbnail.toPNG();
            const data = buffer.toString('base64');
            transcriptWindow.webContents.send('control-window:assistant-attach', {
                name: `${source.name || 'screen'}.png`,
                mime: 'image/png',
                data
            });
        } catch (error) {
            transcriptWindow?.webContents.send('control-window:assistant-attach', {
                error: error?.message || 'Failed to capture screen.'
            });
        }
    });

    const openSettingsShortcut = 'CommandOrControl+,';
    shortcutManager.registerShortcut(openSettingsShortcut, () => {
        if (isTranscriptionActive()) {
            console.log('[Shortcut] Settings shortcut blocked while transcription is active.');
            return;
        }
        ensureSettingsWindowVisible();
    });

    /* Reveal or hide the transcript shortcut guide */
    const toggleGuideShortcut = 'CommandOrControl+H';
    shortcutManager.registerShortcut(toggleGuideShortcut, () => {
        sendToTranscriptWindow('control-window:toggle-guide');
    });

    /* Control apps position */
    const moveLeft = 'CommandOrControl+Left';
    shortcutManager.registerShortcut(moveLeft, () => moveOverlaysBy(-moveStepPx, 0));

    const moveRight = 'CommandOrControl+Right';
    shortcutManager.registerShortcut(moveRight, () => moveOverlaysBy(moveStepPx, 0));

    const moveUp = 'CommandOrControl+Up';
    shortcutManager.registerShortcut(moveUp, () => moveOverlaysBy(0, -moveStepPx));

    const moveDown = 'CommandOrControl+Down';
    shortcutManager.registerShortcut(moveDown, () => moveOverlaysBy(0, moveStepPx));

    /* Gracefully quit app */
    const quitAppShortcut = 'Alt+Shift+Q';

    /* Hide or unhide the app */
    const visibilityToggleShortcut = 'CommandOrControl+Shift+B';
    shortcutManager.registerShortcut(visibilityToggleShortcut, () => {
        if (!isAssistantEnabled()) {
            ensureSettingsWindowVisible();
            return;
        }
        if (!canShowMainExperience()) {
            return;
        }

        let transcriptWindow = getActiveTranscriptWindow();
        if (!transcriptWindow) {
            ensureOverlayWindowsVisible();
            transcriptWindow = getActiveTranscriptWindow();
            if (!transcriptWindow) {
                return;
            }
        }

        const isVisible = typeof transcriptWindow.isVisible === 'function' ? transcriptWindow.isVisible() : true;

        if (isVisible) {
            try {
                transcriptWindow.hide();
            } catch (err) {
                console.warn('[Shortcut] Failed to hide transcript window', err);
            }

            const allowedShortcuts = new Set(
                [visibilityToggleShortcut, attachImageShortcut, toggleMicShortcut, quitAppShortcut, toggleGuideShortcut, openSettingsShortcut]
                    .filter(Boolean)
            );
            shortcutManager.unregisterAllShortcutsExcept(allowedShortcuts);
            return;
        }

        try {
            if (stealthModeEnabled && typeof transcriptWindow.showInactive === 'function') {
                transcriptWindow.showInactive();
            } else {
                transcriptWindow.show();
                if (!stealthModeEnabled) {
                    transcriptWindow.focus();
                }
            }
        } catch (err) {
            console.warn('[Shortcut] Failed to show transcript window', err);
            return;
        }

        shortcutManager.registerAllShortcuts();
        positionOverlayWindows();
    });

    shortcutManager.registerShortcut(quitAppShortcut, () => {
        console.log('[Shortcut] Quit shortcut invoked.');
        app.quit();
    });

    screen.on('display-metrics-changed', positionOverlayWindows);
    screen.on('display-added', positionOverlayWindows);
    screen.on('display-removed', positionOverlayWindows);

    app.on('activate', () => {
        canShowMainExperience();
    });

    registerDesktopCaptureHandler({ ipcMain, desktopCapturer });

    transcriptionConfig = loadTranscriptionConfig();

    transcriptionInitPromise = createTranscriptionService(transcriptionConfig)
        .then((service) => {
            transcriptionService = service;

            const emitToOwner = (sessionId, payload) => {
                const windowId = sessionWindowMap.get(sessionId);
                if (!windowId) {
                    return;
                }
                const targetWindow = BrowserWindow.fromId(windowId);
                if (!targetWindow) {
                    return;
                }
                targetWindow.webContents.send('transcription:stream', payload);
            };

            const emitToTranscriptOverlay = (payload) => {
                const transcriptWindow = getTranscriptWindow();
                if (!transcriptWindow || transcriptWindow.isDestroyed()) {
                    return;
                }
                transcriptWindow.webContents.send('transcription:stream', payload);
            };

            service.on('session-started', ({ sessionId, sourceName, sourceType }) => {
                if (sessionId) {
                    activeTranscriptionSessions.add(sessionId);
                }
                emitToOwner(sessionId, { type: 'started', sessionId, sourceName, sourceType });
                emitToTranscriptOverlay({ type: 'started', sessionId, sourceName, sourceType });
            });

            service.on('session-update', (payload) => {
                emitToOwner(payload.sessionId, { type: 'update', ...payload });
                emitToTranscriptOverlay({ type: 'update', ...payload });
            });

            service.on('session-warning', (payload) => {
                emitToOwner(payload.sessionId, { type: 'warning', ...payload });
                emitToTranscriptOverlay({ type: 'warning', ...payload });
            });

            service.on('session-heartbeat', (payload) => {
                emitToOwner(payload.sessionId, { type: 'heartbeat', ...payload });
                emitToTranscriptOverlay({ type: 'heartbeat', ...payload });
            });

            service.on('session-error', (payload) => {
                emitToOwner(payload.sessionId, { type: 'error', ...payload });
                emitToTranscriptOverlay({ type: 'error', ...payload });
            });

            service.on('session-stopped', (payload) => {
                emitToOwner(payload.sessionId, { type: 'stopped', ...payload });
                emitToTranscriptOverlay({ type: 'stopped', ...payload });
                sessionWindowMap.delete(payload.sessionId);
                if (payload?.sessionId) {
                    activeTranscriptionSessions.delete(payload.sessionId);
                }
            });

            return service;
        })
        .catch((error) => {
            console.error('[Transcription] Failed to initialize service', error);
            transcriptionService = null;
        });

    registerTranscriptionHandlers({
        ipcMain,
        BrowserWindow,
        ensureTranscriptionService,
        getTranscriptionService: () => transcriptionService,
        transcriptionConfig,
        sessionWindowMap
    });

    registerAssistantHandlers({
        ipcMain,
        BrowserWindow,
        ensureAssistantService,
        getAssistantService: () => assistantService,
        sessionWindowMap: assistantSessionWindowMap,
        assistantConfig,
        getAssistantConfig: () => assistantConfig
    });
};

app.whenReady().then(initializeApp);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

ipcMain.on('overlay:move-direction', (_event, payload = {}) => {
    const direction = typeof payload.direction === 'string' ? payload.direction.toLowerCase() : '';
    let dx = 0;
    let dy = 0;

    switch (direction) {
        case 'left':
            dx = -MOVE_STEP_PX;
            break;
        case 'right':
            dx = MOVE_STEP_PX;
            break;
        case 'up':
            dy = -MOVE_STEP_PX;
            break;
        case 'down':
            dy = MOVE_STEP_PX;
            break;
        default:
            return;
    }

    windowManager.moveOverlaysBy(dx, dy);
});

module.exports = {
    initializeApp
};
