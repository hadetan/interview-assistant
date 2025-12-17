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

const loadBlankNativeImage = ({ nativeImage, pathModule, fsModule }) => {
    try {
        const blankIconPath = pathModule.join(__dirname, '..', 'tools', 'blank.png');
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
    windowVerticalGap = 14,
    windowTopMargin = 12,
    moveStepPx = 50,
    app
}) => {
    const overlayWebPreferences = {
        preload: pathModule.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
    };

    const blankNativeImage = loadBlankNativeImage({ nativeImage, pathModule, fsModule });

    let controlWindow = null;
    let transcriptWindow = null;
    let lastAppliedTranscriptHeight = FALLBACK_TRANSCRIPT_HEIGHT;

    const getControlBounds = () => (controlWindow && !controlWindow.isDestroyed() ? controlWindow.getBounds() : null);
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
            // ignore content size access failures while the window initializes
        }
        const bounds = getTranscriptBounds();
        return bounds?.width || DEFAULT_TRANSCRIPT_WIDTH;
    };

    const resolveTranscriptHeightBounds = () => {
        const controlBounds = getControlBounds();
        const anchorBounds = getTranscriptBounds() || controlBounds;
        const workArea = resolveWorkArea(screen, anchorBounds);
        const bottomMargin = windowTopMargin;
        const reservedTop = windowTopMargin + (controlBounds ? controlBounds.height + windowVerticalGap : 0);
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
        const distEntry = pathModule.join(__dirname, '..', 'dist', 'renderer', 'index.html');
        if (fsModule.existsSync(distEntry)) {
            return distEntry;
        }
        return pathModule.join(__dirname, '..', 'src', 'index.html');
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
        if (!controlWindow && !transcriptWindow) {
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

        if (controlWindow && !controlWindow.isDestroyed()) {
            const controlBounds = controlWindow.getBounds();
            const controlX = originX + Math.round((areaWidth - controlBounds.width) / 2);
            const controlY = originY + windowTopMargin;
            controlWindow.setPosition(controlX, controlY);

            if (transcriptWindow && !transcriptWindow.isDestroyed()) {
                const transcriptBounds = transcriptWindow.getBounds();
                const transcriptX = originX + Math.round((areaWidth - transcriptBounds.width) / 2);
                const transcriptY = controlY + controlBounds.height + windowVerticalGap;
                transcriptWindow.setPosition(transcriptX, transcriptY);
            }
            return;
        }

        if (transcriptWindow && !transcriptWindow.isDestroyed()) {
            const transcriptBounds = transcriptWindow.getBounds();
            const transcriptX = originX + Math.round((areaWidth - transcriptBounds.width) / 2);
            const transcriptY = originY + windowTopMargin;
            transcriptWindow.setPosition(transcriptX, transcriptY);
        }
    };

    const moveOverlaysBy = (dx, dy) => {
        const controlAlive = controlWindow && !controlWindow.isDestroyed();
        const transcriptAlive = transcriptWindow && !transcriptWindow.isDestroyed();

        if (!controlAlive && !transcriptAlive) {
            return;
        }

        const controlBounds = controlAlive ? controlWindow.getBounds() : null;
        const transcriptBounds = transcriptAlive ? transcriptWindow.getBounds() : null;

        const nextTranscript = transcriptBounds ? {
            ...transcriptBounds,
            x: transcriptBounds.x + dx,
            y: transcriptBounds.y + dy
        } : null;

        let nextControl = null;

        if (controlBounds) {
            if (nextTranscript) {
                const centeredX = nextTranscript.x + Math.round((nextTranscript.width - controlBounds.width) / 2);
                const centeredY = nextTranscript.y - (controlBounds.height + windowVerticalGap);
                nextControl = { ...controlBounds, x: centeredX, y: centeredY };
            } else {
                nextControl = { ...controlBounds, x: controlBounds.x + dx, y: controlBounds.y + dy };
            }
        }

        const anchor = nextTranscript || nextControl || transcriptBounds || controlBounds;
        const workArea = resolveWorkArea(screen, anchor);
        const [clampedControl, clampedTranscript] = clampOverlaysWithinArea([nextControl, nextTranscript], workArea);

        if (controlAlive && clampedControl) {
            controlWindow.setPosition(clampedControl.x, clampedControl.y);
        }

        if (transcriptAlive && clampedTranscript) {
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

    const createControlWindow = () => {
        if (controlWindow && !controlWindow.isDestroyed()) {
            return controlWindow;
        }

        controlWindow = new BrowserWindow({
            width: 320,
            height: 90,
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
            webPreferences: overlayWebPreferences,
        });

        if (stealthModeEnabled) {
            controlWindow.setAlwaysOnTop(true, 'screen-saver');
            controlWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        } else {
            controlWindow.setAlwaysOnTop(true, 'normal');
            controlWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }
        controlWindow.setFullScreenable(false);
        controlWindow.setIgnoreMouseEvents(true, { forward: true });

        controlWindow.once('ready-to-show', () => {
            if (stealthModeEnabled) {
                controlWindow?.showInactive();
            } else {
                controlWindow?.show();
                controlWindow?.focus();
            }
            controlWindow?.setIgnoreMouseEvents(true, { forward: true });
            positionOverlayWindows();
        });

        controlWindow.on('resized', positionOverlayWindows);

        controlWindow.on('closed', () => {
            controlWindow = null;
            if (transcriptWindow && !transcriptWindow.isDestroyed()) {
                transcriptWindow.close();
            }
        });

        controlWindow.on('focus', () => {
            if (stealthModeEnabled) {
                controlWindow.blur();
            }
        });

        loadRendererForWindow(controlWindow, 'control');
        return controlWindow;
    };

    const createTranscriptWindow = () => {
        if (transcriptWindow && !transcriptWindow.isDestroyed()) {
            return transcriptWindow;
        }

        transcriptWindow = new BrowserWindow({
            width: DEFAULT_TRANSCRIPT_WIDTH,
            height: FALLBACK_TRANSCRIPT_HEIGHT,
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
        const initialHeight = Math.min(Math.max(FALLBACK_TRANSCRIPT_HEIGHT, minHeight), maxHeight);
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
            if (!controlWindow || controlWindow.isDestroyed()) {
                if (app?.quit) {
                    app.quit();
                }
            }
        });

        loadRendererForWindow(transcriptWindow, 'transcript');
        return transcriptWindow;
    };

    const getControlWindow = () => controlWindow;
    const getTranscriptWindow = () => transcriptWindow;

    return {
        createControlWindow,
        createTranscriptWindow,
        positionOverlayWindows,
        moveOverlaysBy,
        getControlWindow,
        getTranscriptWindow,
        clampOverlaysWithinArea,
        resolveWorkArea,
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
