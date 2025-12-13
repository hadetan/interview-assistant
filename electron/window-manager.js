const path = require('node:path');
const fs = require('node:fs');

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
            width: 1080,
            height: 720,
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

        transcriptWindow.on('closed', () => {
            transcriptWindow = null;
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
