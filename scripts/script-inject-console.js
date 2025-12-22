// ==================== Inject this script in browser ====================
/**
 * You can visit about:windows in browser and in console dump this whole script there and test the app out.
 * It's a very light and simple cheat detector.
 */
(function () {
    if (window.cheatDetector) {
        console.warn("cheatDetector already running. Use window.cheatDetector.stop() to stop.");
        return;
    }

    const config = {
        leaveThresholdMs: 50,
        minReportIntervalMs: 50,
        enableBeacon: false,
        beaconUrl: '/report'
    };

    const state = {
        lastFocusState: document.hasFocus(),
        lastVisibleState: document.visibilityState,
        lastEventAt: Date.now(),
        leaveTimer: null,
        lastReportedAt: 0,
        leaves: [],
        currentLeaveStart: null,
        running: true
    };

    // Overlay
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2147483647,
        pointerEvents: 'none',
        fontFamily: 'Arial, sans-serif',
        fontSize: '32px',
        color: 'white',
        background: 'rgba(0,0,0,0.6)'
    });
    overlay.textContent = 'Focus LOST — Page not active';
    document.documentElement.appendChild(overlay);

    const showOverlay = () => overlay.style.display = 'flex';
    const hideOverlay = () => overlay.style.display = 'none';
    const now = () => Date.now();

    function startLeave(reason) {
        if (state.currentLeaveStart) return;
        state.currentLeaveStart = { start: now(), reason };

        clearTimeout(state.leaveTimer);
        state.leaveTimer = setTimeout(() => {
            showOverlay();
            logLeaveStart(reason);
        }, config.leaveThresholdMs);
    }

    function cancelLeave() {
        clearTimeout(state.leaveTimer);
        if (state.currentLeaveStart && state.currentLeaveStart._reported) {
            endLeave();
        } else {
            state.currentLeaveStart = null;
        }
        hideOverlay();
    }

    function logLeaveStart(reason) {
        if (!state.currentLeaveStart) return;
        state.currentLeaveStart._reported = true;
        state.currentLeaveStart.reason = reason;
        state.currentLeaveStart.reportedAt = now();

        state.leaves.push({
            start: state.currentLeaveStart.start,
            reason
        });

        maybeSendReport('leave-start', state.currentLeaveStart);
        state.lastReportedAt = now();

        console.warn('Leave START detected:', state.currentLeaveStart);
    }

    function endLeave() {
        if (!state.currentLeaveStart) return;
        const end = now();
        const duration = end - state.currentLeaveStart.start;
        const last = state.leaves[state.leaves.length - 1];

        if (last && !last.end) {
            last.end = end;
            last.duration = duration;
        } else {
            state.leaves.push({
                start: state.currentLeaveStart.start,
                end,
                duration,
                reason: state.currentLeaveStart.reason
            });
        }

        maybeSendReport('leave-end', last);
        console.warn('Leave END detected (duration ms):', duration, state.currentLeaveStart.reason);

        state.currentLeaveStart = null;
        clearTimeout(state.leaveTimer);
        hideOverlay();
    }

    function maybeSendReport(type, payload) {
        if (!config.enableBeacon) return;
        if (!navigator.sendBeacon) return;

        const nowt = now();
        if (nowt - state.lastReportedAt < config.minReportIntervalMs) return;

        const data = {
            type,
            ts: nowt,
            page: location.href,
            payload
        };

        try {
            navigator.sendBeacon(config.beaconUrl, JSON.stringify(data));
        } catch (e) {
            console.error('Beacon failed', e);
        }
        state.lastReportedAt = nowt;
    }

    // Event Handlers
    const onVisibilityChange = () => {
        const vs = document.visibilityState;
        if (vs === 'hidden') startLeave('visibility-hidden');
        else if (vs === 'visible') cancelLeave();

        state.lastVisibleState = vs;
        state.lastEventAt = now();
    };

    const onWindowBlur = () => {
        startLeave('window-blur');
        state.lastEventAt = now();
    };

    const onWindowFocus = () => {
        if (state.currentLeaveStart && state.currentLeaveStart._reported) endLeave();
        else cancelLeave();
        state.lastEventAt = now();
    };

    const onPageHide = () => {
        startLeave('pagehide');
        state.lastEventAt = now();
    };

    const onFullscreenChange = () => {
        if (!document.fullscreenElement) startLeave('fullscreen-exit');
        else cancelLeave();
    };

    // Poll fallback
    let pollInterval = setInterval(() => {
        if (!state.running) return;
        const focused = document.hasFocus();

        if (!focused && !state.currentLeaveStart) {
            startLeave('poll-hasFocus-false');
        } else if (focused && state.currentLeaveStart) {
            if (state.currentLeaveStart._reported) endLeave();
            else cancelLeave();
        }
    }, 800);

    // Attach listeners
    window.addEventListener('blur', onWindowBlur, true);
    window.addEventListener('focus', onWindowFocus, true);
    document.addEventListener('visibilitychange', onVisibilityChange, true);
    window.addEventListener('pagehide', onPageHide, true);
    document.addEventListener('fullscreenchange', onFullscreenChange, true);

    // DevTools Timing Spike Detector
    (function devtoolsDetector() {
        let last = performance.now();
        let devtoolsOpen = false;

        function check() {
            const t = performance.now();
            const diff = t - last;
            last = t;

            if (diff > 200) {
                if (!devtoolsOpen) {
                    devtoolsOpen = true;
                    state.leaves.push({ start: Date.now(), reason: 'devtools-open' });
                    console.warn('DevTools likely opened.');
                }
            } else {
                if (devtoolsOpen) {
                    devtoolsOpen = false;
                    console.warn('DevTools likely closed.');
                }
            }
        }

        setInterval(check, 100);
    })();

    // Rapid Resize Detector
    (function windowResizeDetector() {
        let resizeBurst = 0;
        let lastResize = 0;

        window.addEventListener('resize', () => {
            const t = Date.now();
            if (t - lastResize < 300) resizeBurst++;
            else resizeBurst = 1;

            lastResize = t;

            if (resizeBurst >= 5) {
                state.leaves.push({ start: t, reason: 'rapid-resize-burst' });
                console.warn('Rapid resize burst detected.');
            }
        });
    })();

    // Suspicious Shortcut Detector
    (function shortcutDetector() {
        const watched = ['F11', 'F12', 'PrintScreen', 'Alt', 'Meta'];

        window.addEventListener('keydown', e => {
            if (watched.includes(e.key)) {
                state.leaves.push({
                    start: Date.now(),
                    reason: 'key-' + e.key.toLowerCase()
                });
                console.warn('Suspicious key:', e.key);
            }
        });
    })();

    // Inactivity Detector
    (function inactivityDetector() {
        let lastAction = Date.now();
        let warned = false;

        const bump = () => {
            lastAction = Date.now();
            warned = false;
        };

        window.addEventListener('mousemove', bump);
        window.addEventListener('keydown', bump);
        window.addEventListener('click', bump);

        setInterval(() => {
            const idle = Date.now() - lastAction;
            if (idle > 20000 && !warned) {
                warned = true;
                state.leaves.push({ start: Date.now(), reason: 'inactivity-20s' });
                console.warn('Extended inactivity detected.');
            }
        }, 2000);
    })();

    // Clipboard Watch
    (function clipboardDetector() {
        document.addEventListener('copy', () => {
            state.leaves.push({ start: Date.now(), reason: 'copy-event' });
            console.warn('Copy event');
        });

        document.addEventListener('paste', () => {
            state.leaves.push({ start: Date.now(), reason: 'paste-event' });
            console.warn('Paste event');
        });
    })();

    // Scroll Speed Detector
    (function scrollSpeedDetector() {
        let last = 0;

        window.addEventListener('scroll', () => {
            const t = Date.now();
            const diff = t - last;
            last = t;

            if (diff < 10) {
                state.leaves.push({ start: t, reason: 'scroll-too-fast' });
                console.warn('Scroll spike detected.');
            }
        });
    })();

    // Tab Switching Speed Detector
    (function tabSwitchDetector() {
        let lastSwitch = 0;

        document.addEventListener('visibilitychange', () => {
            const nowt = Date.now();
            if (document.visibilityState === 'visible') {
                if (nowt - lastSwitch < 150) {
                    state.leaves.push({ start: nowt, reason: 'rapid-tab-switch' });
                    console.warn('Rapid tab switching detected.');
                }
                lastSwitch = nowt;
            }
        });
    })();

    // Mouse Teleport Detector (impossible movement jumps)
    (function mouseTeleportDetector() {
        let lastX = null, lastY = null;

        window.addEventListener('mousemove', e => {
            if (lastX !== null) {
                const dx = Math.abs(e.clientX - lastX);
                const dy = Math.abs(e.clientY - lastY);
                if (dx > 200 || dy > 200) {
                    state.leaves.push({ start: Date.now(), reason: 'mouse-teleport' });
                    console.warn('Mouse teleport movement detected.');
                }
            }
            lastX = e.clientX;
            lastY = e.clientY;
        });
    })();

    // Suspicious Focus Flicker Detector
    (function focusFlickerDetector() {
        let lastFocus = Date.now();
        let count = 0;

        window.addEventListener('focus', () => {
            const t = Date.now();
            if (t - lastFocus < 150) {
                count++;
                if (count >= 3) {
                    state.leaves.push({ start: t, reason: 'focus-flicker' });
                    console.warn('Rapid focus flicker detected.');
                }
            } else count = 1;
            lastFocus = t;
        });
    })();

    // Suspicious Scroll-to-Top Detector
    (function jumpScrollDetector() {
        let lastPos = window.scrollY;

        window.addEventListener('scroll', () => {
            const cur = window.scrollY;
            if (Math.abs(cur - lastPos) > 1500) {
                state.leaves.push({ start: Date.now(), reason: 'massive-scroll-jump' });
                console.warn('Suspicious massive scroll jump.');
            }
            lastPos = cur;
        });
    })();

    // Mouse Leave / Page Edge Exit Detector
    (function mouseLeaveDetector() {
        let lastEnter = Date.now();

        // When mouse ENTERS the page again
        document.addEventListener('mouseenter', () => {
            const t = Date.now();

            // Very fast re-entry → suspicious (like switching windows)
            if (t - lastEnter < 100) {
                state.leaves.push({ start: t, reason: 'rapid-reenter' });
                console.warn('Mouse re-entered too quickly.');
            }

            lastEnter = t;
        });

        // When mouse LEAVES the entire page area
        document.addEventListener('mouseleave', () => {
            const t = Date.now();

            state.leaves.push({
                start: t,
                reason: 'mouse-left-page'
            });

            console.warn('Mouse left the page boundary.');
        });

        // Edge-case: leaving viewport via OUT event
        document.addEventListener('mouseout', e => {
            if (!e.relatedTarget && !e.toElement) {
                const t = Date.now();
                state.leaves.push({ start: t, reason: 'mouse-outside-viewport' });
                console.warn('Mouse exited viewport (mouseout).');
            }
        });
    })();

    // WebGPU Timing Stall Detector - Detects hidden overlays or apps that hog GPU cycles.
    (function webgpuTimingDetector() {
        if (!('gpu' in navigator)) return;

        let last = performance.now();

        function tick() {
            const nowt = performance.now();
            const diff = nowt - last;
            last = nowt;

            // Normal frames ~16ms (60hz), 8ms (120hz), 4ms (240hz)
            // A hidden overlay grabbing GPU will cause a fat spike.
            if (diff > 100) {
                state.leaves.push({ start: Date.now(), reason: 'gpu-stall-overlay' });
                console.warn('Massive GPU stall — possible hidden overlay.');
            }

            requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
    })();

    // Invisible Focus-Steal Detector - Hidden windows or AI tools sometimes pull transient focus.
    // This detects sub-50ms focus flashes impossible for humans.
    (function ghostFocusStealDetector() {
        let last = Date.now();

        window.addEventListener('blur', () => last = Date.now());

        window.addEventListener('focus', () => {
            const nowt = Date.now();
            if (nowt - last < 50) {
                state.leaves.push({ start: nowt, reason: 'ghost-focus-steal' });
                console.warn('Impossible fast focus steal — likely a ghost overlay.');
            }
        });
    })();

    // Memory Pressure Spike Detector - Off-screen apps that OCR the screen cause RAM pressure spikes.
    (function memoryPressureDetector() {
        if (!performance.memory) return;

        let lastUsed = performance.memory.usedJSHeapSize;

        setInterval(() => {
            const used = performance.memory.usedJSHeapSize;

            // Sudden unprovoked jumps = something reading lots of data
            if (used - lastUsed > 5_000_000) { // +5MB in under a second
                state.leaves.push({ start: Date.now(), reason: 'memory-ocr-spike' });
                console.warn('Large JS memory spike — possible screen OCR tool.');
            }

            lastUsed = used;
        }, 1000);
    })();

    // Hidden Window Z-Fighting Detector
    (function zFightingDetector() {
        let last = window.innerHeight;

        setInterval(() => {
            const h = window.innerHeight;

            // 1–2px jumps are typical when OS manages a top-layer window
            if (Math.abs(h - last) > 0 && Math.abs(h - last) < 4) {
                state.leaves.push({ start: Date.now(), reason: 'z-fighting' });
                console.warn('Z-index fighting detected — hidden window overlay.');
            }

            last = h;
        }, 300);
    })();

    // OCR Text Refresh Detector
    (function ocrRefreshDetector() {
        let last = performance.now();
        let spikes = 0;

        setInterval(() => {
            const t = performance.now();
            const diff = t - last;
            last = t;

            // Periodic 5–12ms spike is classic OCR capture interval
            if (diff >= 195 && diff <= 840) {
                spikes++;
                if (spikes >= 5) {
                    state.leaves.push({ start: Date.now(), reason: 'ocr-refresh-pattern' });
                    console.warn('OCR refresh pattern detected.');
                    spikes = 0;
                }
            } else spikes = 0;
        }, 50);
    })();

    // ====================================================================================
    // EXPOSE CONTROL API
    // ====================================================================================

    window.cheatDetector = {
        config,
        state,
        startLeave,
        cancelLeave,
        endLeave,
        showOverlay,
        hideOverlay,
        stop() {
            if (!state.running) return;
            state.running = false;
            clearTimeout(state.leaveTimer);
            clearInterval(pollInterval);

            window.removeEventListener('blur', onWindowBlur, true);
            window.removeEventListener('focus', onWindowFocus, true);
            document.removeEventListener('visibilitychange', onVisibilityChange, true);
            window.removeEventListener('pagehide', onPageHide, true);
            document.removeEventListener('fullscreenchange', onFullscreenChange, true);

            overlay.remove();
            delete window.cheatDetector;

            console.log('cheatDetector stopped and removed.');
        },
        getStats() {
            return {
                leaves: state.leaves.slice(),
                totalLeaves: state.leaves.length,
                lastEventAt: state.lastEventAt
            };
        },
        testLeave(ms = 2000) {
            startLeave('manual-test');
            setTimeout(() => {
                if (state.currentLeaveStart && state.currentLeaveStart._reported) endLeave();
                else cancelLeave();
            }, ms);
        }
    };

    console.log('cheatDetector running. Inspect window.cheatDetector for details.');
})();
