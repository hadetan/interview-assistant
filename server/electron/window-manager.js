const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_TRANSCRIPT_WIDTH = 1080;
const FALLBACK_TRANSCRIPT_HEIGHT = 520;
const MIN_TRANSCRIPT_HEIGHT = 320;

const clampOverlaysWithinArea = (targets, workArea) => {
    const rects = targets.filter(Boolean);
    if (!rects.length || !workArea?.width || !workArea?.height) {
        return targets;
    }

    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.width));
    const maxY = Math.max(...rects.map((r) => r.y + r.height));

    const group = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
    };

    const areaRight = workArea.x + workArea.width;
    const areaBottom = workArea.y + workArea.height;

    let deltaX = 0;
    let deltaY = 0;

    if (group.x < workArea.x) {
        deltaX = workArea.x - group.x;
    } else if (group.x + group.width > areaRight) {
        deltaX = areaRight - (group.x + group.width);
    }

    if (group.y < workArea.y) {
        deltaY = workArea.y - group.y;
    } else if (group.y + group.height > areaBottom) {
        deltaY = areaBottom - (group.y + group.height);
    }

    if (!deltaX && !deltaY) {
        return targets;
    }

    return targets.map((rect) => (rect ? { ...rect, x: rect.x + deltaX, y: rect.y + deltaY } : rect));
};

const resolveWorkArea = (screen, bounds) => {
    const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
    const targetDisplay = display || screen.getPrimaryDisplay();
    const raw = targetDisplay?.workArea || targetDisplay?.bounds;
    const width = raw?.width ?? targetDisplay?.workAreaSize?.width ?? targetDisplay?.size?.width ?? 0;
    const height = raw?.height ?? targetDisplay?.workAreaSize?.height ?? targetDisplay?.size?.height ?? 0;
    const x = raw?.x ?? 0;
    const y = raw?.y ?? 0;
    return { x, y, width, height };
};

const loadBlankNativeImage = ({ nativeImage, pathModule, fsModule, projectRoot }) => {
    try {
        const blankIconPath = pathModule.join(projectRoot, 'tools', 'windows.png');
        if (fsModule.existsSync(blankIconPath)) {
            return nativeImage.createFromPath(blankIconPath);
        }
    } catch (_err) {
        return null;
    }
    return null;
};

const createWindowManager = ({
    BrowserWindow,
    screen,
    nativeImage,
    pathModule = path,
    fsModule = fs,
    stealthModeEnabled = false,
    windowVerticalGap = 0,
    windowTopMargin = 0,
    moveStepPx = 50,
    app
}) => {
    const projectRoot = pathModule.join(__dirname, '..', '..');
    const overlayWebPreferences = {
        preload: pathModule.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
    };

    const blankNativeImage = loadBlankNativeImage({ nativeImage, pathModule, fsModule, projectRoot });

    let transcriptWindow = null;
    let lastAppliedTranscriptHeight = FALLBACK_TRANSCRIPT_HEIGHT;
    let settingsWindow = null;
    let overlayVisibilitySnapshot = null;
    let permissionWindow = null;
    const getTranscriptBounds = () => (transcriptWindow && !transcriptWindow.isDestroyed() ? transcriptWindow.getBounds() : null);

    const getTranscriptContentWidth = () => {
        if (!transcriptWindow || transcriptWindow.isDestroyed()) {
            return DEFAULT_TRANSCRIPT_WIDTH;
        }
        try {
            const [contentWidth] = transcriptWindow.getContentSize();
            if (Number.isFinite(contentWidth) && contentWidth > 0) {
                return contentWidth;
            }
        } catch (_err) {
            // ignore inability to access content size while window initializes
        }
        const bounds = getTranscriptBounds();
        return bounds?.width || DEFAULT_TRANSCRIPT_WIDTH;
    };

    const resolveTranscriptHeightBounds = () => {
        const anchorBounds = getTranscriptBounds();
        const workArea = resolveWorkArea(screen, anchorBounds);
        const bottomMargin = windowTopMargin;
        const reservedTop = windowTopMargin;
        const rawAvailable = (workArea?.height ?? 0) - reservedTop - bottomMargin;

        if (rawAvailable <= 0) {
            return {
                minHeight: MIN_TRANSCRIPT_HEIGHT,
                maxHeight: Math.max(MIN_TRANSCRIPT_HEIGHT, FALLBACK_TRANSCRIPT_HEIGHT)
            };
        }

        const minHeight = Math.min(MIN_TRANSCRIPT_HEIGHT, rawAvailable);
        return {
            minHeight,
            maxHeight: Math.max(minHeight, rawAvailable)
        };
    };

    const resizeTranscriptWindow = (nextHeight) => {
        if (!transcriptWindow || transcriptWindow.isDestroyed()) {
            return false;
        }
        const normalizedHeight = Math.max(1, Math.round(nextHeight));
        if (normalizedHeight === lastAppliedTranscriptHeight) {
            return false;
        }
        const targetWidth = getTranscriptContentWidth();
        lastAppliedTranscriptHeight = normalizedHeight;
        transcriptWindow.setContentSize(targetWidth, normalizedHeight);
        return true;
    };

    const clampTranscriptHeightWithinWorkArea = () => {
        if (!transcriptWindow || transcriptWindow.isDestroyed()) {
            return;
        }
        const bounds = getTranscriptBounds();
        const currentHeight = bounds?.height ?? lastAppliedTranscriptHeight;
        const { minHeight, maxHeight } = resolveTranscriptHeightBounds();
        const clamped = Math.min(Math.max(currentHeight, minHeight), maxHeight);
        if (clamped !== currentHeight) {
            resizeTranscriptWindow(clamped);
        }
    };

    const resolveRendererEntry = () => {
        const distEntry = pathModule.join(projectRoot, 'dist', 'renderer', 'index.html');
        if (fsModule.existsSync(distEntry)) {
            return distEntry;
        }
        return pathModule.join(projectRoot, 'src', 'index.html');
    };

    const loadRendererForWindow = (targetWindow, windowVariant) => {
        if (!targetWindow) {
            return;
        }

        if (process.env.ELECTRON_START_URL) {
            let targetUrl;
            try {
                const parsed = new URL(process.env.ELECTRON_START_URL);
                parsed.searchParams.set('window', windowVariant);
                targetUrl = parsed.toString();
            } catch (_error) {
                targetUrl = process.env.ELECTRON_START_URL;
            }
            targetWindow.loadURL(targetUrl);
            return;
        }

        targetWindow.loadFile(resolveRendererEntry(), { query: { window: windowVariant } });
    };

    const positionOverlayWindows = () => {
        if (!transcriptWindow || transcriptWindow.isDestroyed()) {
            return;
        }

        clampTranscriptHeightWithinWorkArea();

        const primaryDisplay = screen.getPrimaryDisplay();
        if (!primaryDisplay) {
            return;
        }

        const workArea = primaryDisplay.workArea || primaryDisplay.bounds;
        const areaWidth = workArea?.width ?? primaryDisplay.workAreaSize?.width ?? primaryDisplay.size?.width;
        const originX = workArea?.x ?? 0;
        const originY = workArea?.y ?? 0;

        const transcriptBounds = transcriptWindow.getBounds();
        const transcriptX = originX + Math.round((areaWidth - transcriptBounds.width) / 2);
        const transcriptY = originY + windowTopMargin;
        transcriptWindow.setPosition(transcriptX, transcriptY);
    };

    const moveOverlaysBy = (dx, dy) => {
        const transcriptAlive = transcriptWindow && !transcriptWindow.isDestroyed();

        if (!transcriptAlive) {
            return;
        }

        const transcriptBounds = transcriptWindow.getBounds();
        const nextTranscript = {
            ...transcriptBounds,
            x: transcriptBounds.x + dx,
            y: transcriptBounds.y + dy
        };

        const workArea = resolveWorkArea(screen, nextTranscript);
        const [clampedTranscript] = clampOverlaysWithinArea([nextTranscript], workArea);

        if (clampedTranscript) {
            transcriptWindow.setPosition(clampedTranscript.x, clampedTranscript.y);
        }
    };

    const applyTranscriptPreferredHeight = (preferredHeight) => {
        if (!transcriptWindow || transcriptWindow.isDestroyed()) {
            return;
        }
        const { minHeight, maxHeight } = resolveTranscriptHeightBounds();
        const normalized = Number.isFinite(preferredHeight) ? preferredHeight : minHeight;
        const clamped = Math.min(Math.max(Math.round(normalized), minHeight), maxHeight);
        if (resizeTranscriptWindow(clamped)) {
            positionOverlayWindows();
        }
    };

    const createTranscriptWindow = () => {
        if (transcriptWindow && !transcriptWindow.isDestroyed()) {
            return transcriptWindow;
        }

        const anchorBounds = getTranscriptBounds();
        const workArea = resolveWorkArea(screen, anchorBounds);
        const dynamicWidth = Math.max(1, Math.round((workArea.width || DEFAULT_TRANSCRIPT_WIDTH) * 0.5));
        const dynamicHeight = Math.max(1, Math.round((workArea.height || FALLBACK_TRANSCRIPT_HEIGHT) * 0.9));

        transcriptWindow = new BrowserWindow({
            width: dynamicWidth,
            height: dynamicHeight,
            transparent: true,
            frame: false,
            icon: blankNativeImage,
            skipTaskbar: stealthModeEnabled,
            autoHideMenuBar: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            focusable: !stealthModeEnabled,
            show: false,
            hasShadow: false,
            backgroundColor: '#00000000',
            hiddenInMissionControl: stealthModeEnabled,
            acceptFirstMouse: true,
            useContentSize: true,
            enablePreferredSizeMode: true,
            webPreferences: overlayWebPreferences
        });

        if (stealthModeEnabled) {
            transcriptWindow.setAlwaysOnTop(true, 'screen-saver');
            transcriptWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            transcriptWindow.setIgnoreMouseEvents(true, { forward: true });
        } else {
            transcriptWindow.setAlwaysOnTop(true, 'normal');
            transcriptWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            transcriptWindow.setIgnoreMouseEvents(false);
        }
        transcriptWindow.setFullScreenable(false);

        const { minHeight, maxHeight } = resolveTranscriptHeightBounds();
        const initialHeight = Math.min(Math.max(dynamicHeight, minHeight), maxHeight);
        resizeTranscriptWindow(initialHeight);

        transcriptWindow.once('ready-to-show', () => {
            if (stealthModeEnabled) {
                transcriptWindow?.showInactive();
            } else {
                transcriptWindow?.show();
                transcriptWindow?.focus();
            }
            positionOverlayWindows();
        });

        transcriptWindow.on('resized', positionOverlayWindows);

        transcriptWindow.webContents.on('preferred-size-changed', (_event, size) => {
            if (!size || typeof size.height !== 'number') {
                return;
            }
            applyTranscriptPreferredHeight(size.height);
        });

        transcriptWindow.on('closed', () => {
            transcriptWindow = null;
            lastAppliedTranscriptHeight = FALLBACK_TRANSCRIPT_HEIGHT;
            if (app?.quit) {
                app.quit();
            }
        });

        loadRendererForWindow(transcriptWindow, 'transcript');
        return transcriptWindow;
    };

    const getTranscriptWindow = () => transcriptWindow && !transcriptWindow.isDestroyed() ? transcriptWindow : null;

    const hideOverlayWindows = () => {
        const transcript = getTranscriptWindow();
        overlayVisibilitySnapshot = {
            transcriptVisible: Boolean(transcript?.isVisible?.())
        };

        if (transcript) {
            try {
                transcript.hide();
            } catch (error) {
                console.warn('[WindowManager] Failed to hide transcript window', error);
            }
        }
    };

    const restoreOverlayWindows = () => {
        if (!overlayVisibilitySnapshot) {
            overlayVisibilitySnapshot = null;
            return;
        }

        const transcript = getTranscriptWindow();

        if (transcript && overlayVisibilitySnapshot.transcriptVisible) {
            try {
                if (stealthModeEnabled && typeof transcript.showInactive === 'function') {
                    transcript.showInactive();
                } else {
                    transcript.show();
                }
            } catch (error) {
                console.warn('[WindowManager] Failed to restore transcript window', error);
            }
        }

        overlayVisibilitySnapshot = null;
        positionOverlayWindows();
    };

    const destroySettingsWindow = () => {
        if (!settingsWindow || settingsWindow.isDestroyed()) {
            settingsWindow = null;
            return;
        }
        try {
            settingsWindow.close();
        } catch (error) {
            console.warn('[WindowManager] Failed to close settings window', error);
        }
    };

    const getSettingsWindow = () => (settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null);

    const createSettingsWindow = () => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
            if (!settingsWindow.isVisible()) {
                settingsWindow.show();
            }
            settingsWindow.focus();
            return settingsWindow;
        }

        hideOverlayWindows();

        settingsWindow = new BrowserWindow({
            width: 900,
            height: 640,
            frame: true,
            transparent: false,
            resizable: true,
            movable: true,
            minimizable: false,
            maximizable: false,
            autoHideMenuBar: true,
            show: false,
            backgroundColor: '#1f1f1f',
            modal: false,
            webPreferences: {
                preload: pathModule.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false
            }
        });

        settingsWindow.once('ready-to-show', () => {
            settingsWindow?.show();
            settingsWindow?.focus();
        });

        settingsWindow.on('closed', () => {
            settingsWindow = null;
            restoreOverlayWindows();
        });

        loadRendererForWindow(settingsWindow, 'settings');
        return settingsWindow;
    };

    const getPermissionWindow = () => (permissionWindow && !permissionWindow.isDestroyed() ? permissionWindow : null);

    const destroyPermissionWindow = () => {
        if (!permissionWindow || permissionWindow.isDestroyed()) {
            permissionWindow = null;
            return;
        }
        try {
            permissionWindow.close();
        } catch (error) {
            console.warn('[WindowManager] Failed to close permission window', error);
        }
    };

    const sendPermissionStatus = (status) => {
        const target = getPermissionWindow();
        if (!target) {
            return;
        }
        try {
            target.webContents.send('permissions:status', status);
        } catch (error) {
            console.warn('[WindowManager] Failed to send permission status', error);
        }
    };

    const createPermissionWindow = () => {
        if (permissionWindow && !permissionWindow.isDestroyed()) {
            if (!permissionWindow.isVisible()) {
                permissionWindow.show();
            }
            permissionWindow.focus();
            return permissionWindow;
        }

        hideOverlayWindows();

        permissionWindow = new BrowserWindow({
            width: 640,
            height: 720,
            frame: true,
            transparent: false,
            resizable: true,
            minimizable: false,
            maximizable: false,
            autoHideMenuBar: true,
            show: false,
            backgroundColor: '#0f172a',
            title: 'Permissions Required',
            closable: true,
            webPreferences: {
                preload: pathModule.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false
            }
        });

        permissionWindow.setFullScreenable(false);

        permissionWindow.once('ready-to-show', () => {
            permissionWindow?.show();
            permissionWindow?.focus();
        });

        permissionWindow.on('closed', () => {
            permissionWindow = null;
            restoreOverlayWindows();
        });

        loadRendererForWindow(permissionWindow, 'permissions');
        return permissionWindow;
    };

    return {
        createTranscriptWindow,
        createSettingsWindow,
        destroySettingsWindow,
        createPermissionWindow,
        destroyPermissionWindow,
        positionOverlayWindows,
        moveOverlaysBy,
        getTranscriptWindow,
        getSettingsWindow,
        getPermissionWindow,
        hideOverlayWindows,
        restoreOverlayWindows,
        clampOverlaysWithinArea,
        resolveWorkArea,
        sendPermissionStatus,
        moveStepPx,
        windowVerticalGap,
        windowTopMargin
    };
};

module.exports = {
    createWindowManager,
    clampOverlaysWithinArea,
    resolveWorkArea
};