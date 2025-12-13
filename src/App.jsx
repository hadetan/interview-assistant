import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatBubble from './components/ChatBubble';
import './App.css';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;
const DEFAULT_MIME = 'audio/webm;codecs=opus';
const STALL_THRESHOLD_MS = 1500;
const STALL_WATCH_INTERVAL_MS = 1000;
const SCROLL_STEP_PX = 140;
const CONTINUATION_LINGER_MS = 2500;

const resolvePreferredMimeType = () => {
    if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
        return '';
    }
    if (typeof window.MediaRecorder.isTypeSupported !== 'function') {
        return '';
    }
    const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];
    return candidates.find((candidate) => {
        try {
            return window.MediaRecorder.isTypeSupported(candidate);
        } catch (_error) {
            return false;
        }
    }) || '';
};

const buildRecorderOptions = (mimeType) => {
    if (!mimeType) {
        return {};
    }
    return { mimeType };
};

const buildVideoConstraints = (sourceId) => ({
    mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId
    }
});

const buildAudioConstraints = (sourceId, platform) => {
    if (platform === 'darwin') {
        return false;
    }
    return {
        mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
        }
    };
};

const resolveWarningMessage = (payload = {}) => {
    if (payload.warning?.message) {
        return payload.warning.message;
    }
    if (payload.warning?.code) {
        return payload.warning.code;
    }
    if (payload.message) {
        return payload.message;
    }
    return 'Unknown warning';
};

const preferredMimeType = resolvePreferredMimeType();

const WINDOW_VARIANTS = {
    CONTROL: 'control',
    TRANSCRIPT: 'transcript'
};

const resolveWindowVariant = () => {
    if (typeof window === 'undefined') {
        return WINDOW_VARIANTS.TRANSCRIPT;
    }
    const params = new URLSearchParams(window.location.search || '');
    return params.get('window') || WINDOW_VARIANTS.TRANSCRIPT;
};

function App() {
    const [status, setStatus] = useState('Idle');
    const [messages, setMessages] = useState([]);
    const [isSelectingSource, setIsSelectingSource] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [latencyStatus, setLatencyStatus] = useState('');
    const [isAtBottom, setIsAtBottom] = useState(true);

    const windowVariant = useMemo(() => resolveWindowVariant(), []);
    const isControlWindow = windowVariant === WINDOW_VARIANTS.CONTROL;

    const overlayMovementHandledGlobally = useMemo(() => {
        if (typeof electronAPI?.overlay?.movementHandledGlobally === 'boolean') {
            return electronAPI.overlay.movementHandledGlobally;
        }
        return false;
    }, []);

    useEffect(() => {
        if (typeof document === 'undefined') {
            return () => {};
        }
        document.body.dataset.windowMode = windowVariant;
        return () => {
            if (document.body.dataset.windowMode === windowVariant) {
                delete document.body.dataset.windowMode;
            }
        };
    }, [windowVariant]);

    useEffect(() => {
        if (overlayMovementHandledGlobally) {
            return () => {};
        }

        const handler = (event) => {
            const hasModifier = event.ctrlKey || event.metaKey;
            if (!hasModifier) {
                return;
            }

            const directionMap = {
                ArrowLeft: 'left',
                ArrowRight: 'right',
                ArrowUp: 'up',
                ArrowDown: 'down'
            };

            const direction = directionMap[event.key];
            if (!direction) {
                return;
            }

            event.preventDefault();
            try {
                electronAPI?.overlay?.moveDirection?.(direction);
            } catch (_error) {
                // ignore
            }
        };

        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [overlayMovementHandledGlobally]);

    const chunkTimeslice = useMemo(() => {
        if (typeof electronAPI?.getChunkTimesliceMs === 'function') {
            return Number(electronAPI.getChunkTimesliceMs());
        }
        return 200;
    }, []);

    const platform = useMemo(() => {
        if (typeof electronAPI?.getPlatform === 'function') {
            return electronAPI.getPlatform();
        }
        return 'unknown';
    }, []);

    const mediaRecorderRef = useRef(null);
    const captureStreamRef = useRef(null);
    const sessionIdRef = useRef(null);
    const stopTranscriptionListenerRef = useRef(null);
    const chunkSequenceRef = useRef(0);
    const recordingMimeTypeRef = useRef(preferredMimeType || DEFAULT_MIME);
    const messageIdCounterRef = useRef(0);
    const pendingMessageIdRef = useRef(null);
    const continuationMessageIdRef = useRef(null);
    const lastMessageUpdateTsRef = useRef(0);
    const latencyTimerRef = useRef(null);
    const lastLatencyTsRef = useRef(0);
    const latencyLabelRef = useRef('');
    const controlStartRef = useRef(null);
    const controlStopRef = useRef(null);
    const streamingStateRef = useRef(false);
    const selectingSourceRef = useRef(false);
    const transcriptRef = useRef(null);

    const resetTranscriptionListener = useCallback(() => {
        if (typeof stopTranscriptionListenerRef.current === 'function') {
            stopTranscriptionListenerRef.current();
        }
        stopTranscriptionListenerRef.current = null;
    }, []);

    const latencySuffixRef = useRef('');
    const latencySuffixReasonRef = useRef('');
    const formatStalledLabel = useCallback((durationMs) => {
        const seconds = Math.max(1, Math.round(Math.max(0, durationMs) / 1000));
        return `(stalled ${seconds}s)`;
    }, []);
    const updateLatencyStatus = useCallback((overrideSuffix) => {
        const suffix = typeof overrideSuffix === 'string' ? overrideSuffix : latencySuffixRef.current;
        const base = latencyLabelRef.current;
        if (!base && !suffix) {
            setLatencyStatus('');
            return;
        }
        if (!base) {
            setLatencyStatus((suffix || '').trim());
            return;
        }
        const extra = suffix ? ` ${suffix}` : '';
        setLatencyStatus(`Latency ${base}${extra}`);
    }, []);

    const resetLatencyWatchdog = useCallback(() => {
        if (latencyTimerRef.current) {
            clearInterval(latencyTimerRef.current);
            latencyTimerRef.current = null;
        }
        lastLatencyTsRef.current = 0;
        latencyLabelRef.current = '';
        latencySuffixRef.current = '';
        latencySuffixReasonRef.current = '';
        setLatencyStatus('');
    }, []);

    const ensureLatencyWatchdog = useCallback(() => {
        if (latencyTimerRef.current) {
            return;
        }
        latencyTimerRef.current = window.setInterval(() => {
            if (!sessionIdRef.current || !latencyLabelRef.current || !lastLatencyTsRef.current) {
                return;
            }
            const stalledFor = Date.now() - lastLatencyTsRef.current;
            if (stalledFor >= STALL_THRESHOLD_MS && latencySuffixReasonRef.current !== 'heartbeat-silence') {
                latencySuffixRef.current = formatStalledLabel(stalledFor);
                latencySuffixReasonRef.current = 'stall';
                updateLatencyStatus();
            }
        }, STALL_WATCH_INTERVAL_MS);
    }, [formatStalledLabel, updateLatencyStatus]);

    const teardownSession = useCallback(async () => {
        resetTranscriptionListener();
        const currentSessionId = sessionIdRef.current;
        sessionIdRef.current = null;
        if (isControlWindow && currentSessionId && electronAPI?.transcription?.stopSession) {
            try {
                await electronAPI.transcription.stopSession(currentSessionId);
            } catch (_error) {
                // ignore and keep tearing down
            }
        }
        pendingMessageIdRef.current = null;
        continuationMessageIdRef.current = null;
        lastMessageUpdateTsRef.current = 0;
        setMessages([]);
        setIsAtBottom(true);
        resetLatencyWatchdog();
    }, [isControlWindow, resetLatencyWatchdog, resetTranscriptionListener]);

    const stopCapture = useCallback(async () => {
        if (mediaRecorderRef.current) {
            try {
                mediaRecorderRef.current.stop();
            } catch (_error) {
                // ignore
            }
            mediaRecorderRef.current = null;
        }
        if (captureStreamRef.current) {
            captureStreamRef.current.getTracks().forEach((track) => track.stop());
            captureStreamRef.current = null;
        }
        chunkSequenceRef.current = 0;
        recordingMimeTypeRef.current = preferredMimeType || DEFAULT_MIME;
        setIsSelectingSource(false);
        selectingSourceRef.current = false;
        setIsStreaming(false);
        streamingStateRef.current = false;
        await teardownSession();
    }, [teardownSession]);

    const handleChunk = useCallback(async (event) => {
        if (!event?.data?.size || !sessionIdRef.current) {
            return;
        }
        try {
            const sequence = chunkSequenceRef.current;
            chunkSequenceRef.current += 1;
            const arrayBuffer = await event.data.arrayBuffer();
            const captureTimestamp = Date.now();
            electronAPI?.transcription?.sendChunk?.({
                sessionId: sessionIdRef.current,
                sequence,
                mimeType: recordingMimeTypeRef.current,
                data: arrayBuffer,
                timestamp: captureTimestamp,
                captureTimestamp
            });
        } catch (error) {
            console.error('Failed to dispatch audio chunk', error);
        }
    }, []);

    const attachTranscriptionEvents = useCallback(() => {
        if (typeof electronAPI?.transcription?.onEvent !== 'function') {
            return;
        }
        resetTranscriptionListener();
        stopTranscriptionListenerRef.current = electronAPI.transcription.onEvent((payload = {}) => {
            const eventSessionId = payload.sessionId;
            if (!eventSessionId) {
                return;
            }

            if (isControlWindow) {
                if (!sessionIdRef.current || eventSessionId !== sessionIdRef.current) {
                    return;
                }
            } else if (!sessionIdRef.current && payload.type === 'started') {
                sessionIdRef.current = eventSessionId;
            } else if (sessionIdRef.current !== eventSessionId) {
                if (payload.type !== 'stopped') {
                    return;
                }
            }

            switch (payload.type) {
                case 'started':
                    ensureLatencyWatchdog();
                    lastLatencyTsRef.current = Date.now();
                    latencyLabelRef.current = '';
                    latencySuffixRef.current = '';
                    setStatus('Streaming transcription active.');
                    setIsStreaming(true);
                    streamingStateRef.current = true;
                    selectingSourceRef.current = false;
                    break;
                case 'update': {
                    const serverText = typeof payload.text === 'string' ? payload.text : '';
                    const delta = typeof payload.delta === 'string' ? payload.delta : '';
                    const isFinal = Boolean(payload.isFinal);
                    const content = delta || serverText;
                    const now = Date.now();
                    const mergeText = (base, incoming, preferAppend) => {
                        const safeBase = base || '';
                        const safeIncoming = incoming || '';
                        if (!safeIncoming) return safeBase;
                        if (!safeBase) return safeIncoming;
                        if (safeIncoming === safeBase) return safeBase;

                        const baseTrimRight = safeBase.replace(/\s+$/g, '');
                        const incomingTrimLeft = safeIncoming.replace(/^\s+/g, '');

                        if (incomingTrimLeft.startsWith(baseTrimRight)) return incomingTrimLeft;
                        if (baseTrimRight.endsWith(incomingTrimLeft)) return baseTrimRight;

                        let overlap = 0;
                        const maxOverlap = Math.min(baseTrimRight.length, incomingTrimLeft.length);
                        for (let k = maxOverlap; k > 0; k -= 1) {
                            if (baseTrimRight.slice(baseTrimRight.length - k) === incomingTrimLeft.slice(0, k)) {
                                overlap = k;
                                break;
                            }
                        }

                        const remainder = incomingTrimLeft.slice(overlap);
                        const needsSpace = remainder
                            && /[A-Za-z0-9]$/.test(baseTrimRight)
                            && /^[A-Za-z0-9]/.test(remainder)
                            && !/^[,.;:!?]/.test(remainder)
                            && !/\s$/.test(baseTrimRight);
                        const joined = `${baseTrimRight}${needsSpace ? ' ' : ''}${remainder}`;
                        return preferAppend ? joined : joined;
                    };
                    const lastUpdateTs = lastMessageUpdateTsRef.current || 0;
                    const canContinue = lastUpdateTs > 0 && (now - lastUpdateTs) <= CONTINUATION_LINGER_MS;
                    const continuationId = canContinue ? continuationMessageIdRef.current : null;
                    if (!canContinue) {
                        continuationMessageIdRef.current = null;
                    }
                    if (content) {
                        setMessages((prev) => {
                            const next = [...prev];
                            const pendingId = pendingMessageIdRef.current;
                            const targetId = pendingId || continuationId;

                            if (!isFinal) {
                                if (targetId) {
                                    const updated = next.map((msg) => {
                                        if (msg.id !== targetId) return msg;
                                        const appended = mergeText(msg.text, delta ? delta : serverText || content, Boolean(delta));
                                        return { ...msg, text: appended, isFinal: false };
                                    });
                                    pendingMessageIdRef.current = targetId;
                                    continuationMessageIdRef.current = targetId;
                                    lastMessageUpdateTsRef.current = now;
                                    return updated;
                                }
                                const id = `msg-${Date.now()}-${messageIdCounterRef.current += 1}`;
                                pendingMessageIdRef.current = id;
                                continuationMessageIdRef.current = id;
                                lastMessageUpdateTsRef.current = now;
                                next.push({ id, text: content, isFinal: false, ts: now, side: 'left' });
                                return next;
                            }

                            if (targetId) {
                                pendingMessageIdRef.current = null;
                                continuationMessageIdRef.current = targetId;
                                lastMessageUpdateTsRef.current = now;
                                return next.map((msg) => {
                                    if (msg.id !== targetId) return msg;
                                    const finalizedText = serverText
                                        ? serverText
                                        : mergeText(msg.text, delta ? delta : content, Boolean(delta));
                                    return { ...msg, text: finalizedText, isFinal: true };
                                });
                            }

                            const id = `msg-${Date.now()}-${messageIdCounterRef.current += 1}`;
                            pendingMessageIdRef.current = null;
                            continuationMessageIdRef.current = id;
                            lastMessageUpdateTsRef.current = now;
                            next.push({ id, text: serverText || content, isFinal: true, ts: now, side: 'left' });
                            return next;
                        });
                    }
                    lastLatencyTsRef.current = Date.now();
                    latencyLabelRef.current = `WS ${payload.latencyMs ?? '-'}ms | E2E ${payload.pipelineMs ?? '-'}ms | CONV ${payload.conversionMs ?? '-'}ms`;
                    latencySuffixRef.current = '';
                    latencySuffixReasonRef.current = '';
                    ensureLatencyWatchdog();
                    updateLatencyStatus();
                    break;
                }
                case 'warning':
                    resetLatencyWatchdog();
                    latencySuffixRef.current = '';
                    latencySuffixReasonRef.current = '';
                    setStatus(`Transcription warning: ${resolveWarningMessage(payload)}`);
                    break;
                case 'error':
                    resetLatencyWatchdog();
                    latencySuffixRef.current = '';
                    latencySuffixReasonRef.current = '';
                    setStatus(`Transcription error: ${payload.error?.message || 'Unknown error'}`);
                    break;
                case 'stopped':
                    resetLatencyWatchdog();
                    latencySuffixRef.current = '';
                    latencySuffixReasonRef.current = '';
                    setStatus('Transcription session stopped.');
                    pendingMessageIdRef.current = null;
                    setMessages([]);
                    setIsAtBottom(true);
                    setIsStreaming(false);
                    streamingStateRef.current = false;
                    continuationMessageIdRef.current = null;
                    lastMessageUpdateTsRef.current = 0;
                    if (!isControlWindow) {
                        sessionIdRef.current = null;
                    }
                    break;
                case 'heartbeat': {
                    const state = payload.state || (payload.silent ? 'silence' : 'speech');
                    if (state === 'reconnecting') {
                        latencySuffixRef.current = '(reconnecting…)';
                        latencySuffixReasonRef.current = 'reconnecting';
                    } else if (state === 'reconnected') {
                        latencySuffixRef.current = '(reconnected)';
                        latencySuffixReasonRef.current = 'reconnected';
                    } else if (state === 'silence') {
                        const duration = Math.max(0, Number(payload.silenceDurationMs) || 0);
                        latencySuffixRef.current = formatStalledLabel(duration);
                        latencySuffixReasonRef.current = 'heartbeat-silence';
                    } else if (state === 'speech') {
                        if (latencySuffixReasonRef.current === 'heartbeat-silence') {
                            latencySuffixRef.current = '';
                            latencySuffixReasonRef.current = '';
                        }
                    } else {
                        if (latencySuffixReasonRef.current !== 'stall') {
                            latencySuffixRef.current = '';
                            latencySuffixReasonRef.current = '';
                        }
                    }
                    updateLatencyStatus();
                    break;
                }
                default:
                    break;
            }
        });
    }, [ensureLatencyWatchdog, formatStalledLabel, isControlWindow, resetLatencyWatchdog, resetTranscriptionListener, updateLatencyStatus]);

    useEffect(() => {
        if (isControlWindow) {
            return () => {};
        }
        attachTranscriptionEvents();
        return () => {
            resetTranscriptionListener();
        };
    }, [attachTranscriptionEvents, isControlWindow, resetTranscriptionListener]);

    useEffect(() => {
        streamingStateRef.current = isStreaming;
    }, [isStreaming]);

    useEffect(() => {
        selectingSourceRef.current = isSelectingSource;
    }, [isSelectingSource]);

    const startStreamingWithSource = useCallback(async (source) => {
        const sourceId = source?.id;
        if (!sourceId) {
            setStatus('No valid source selected.');
            return;
        }
        setIsSelectingSource(true);
        selectingSourceRef.current = true;
        setStatus('Preparing capture stream…');
        const videoConstraints = buildVideoConstraints(sourceId);
        const audioConstraints = buildAudioConstraints(sourceId, platform);
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints,
                video: videoConstraints
            });
        } catch (error) {
            console.error('Failed to obtain capture stream', error);
            setStatus(`Failed to capture system audio: ${error?.message || error}`);
            setIsSelectingSource(false);
            selectingSourceRef.current = false;
            return;
        }
        captureStreamRef.current = stream;
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) {
            setStatus('No system audio track detected.');
            setIsSelectingSource(false);
            selectingSourceRef.current = false;
            return;
        }
        const audioStream = new MediaStream(audioTracks);
        try {
            const sessionResponse = await electronAPI?.transcription?.startSession?.({
                sourceName: source.name || source.id,
                platform
            });
            sessionIdRef.current = sessionResponse?.sessionId;
        } catch (error) {
            console.error('Failed to start transcription session', error);
            setStatus(`Transcription unavailable: ${error?.message || 'unknown error'}`);
            setIsSelectingSource(false);
            selectingSourceRef.current = false;
            await stopCapture();
            return;
        }
        attachTranscriptionEvents();
        const recorderOptions = buildRecorderOptions(preferredMimeType);
        try {
            mediaRecorderRef.current = new MediaRecorder(audioStream, recorderOptions);
        } catch (error) {
            console.warn('Preferred mime type failed, falling back to default', recorderOptions, error);
            mediaRecorderRef.current = new MediaRecorder(audioStream);
        }
        const recorder = mediaRecorderRef.current;
        recordingMimeTypeRef.current = recorder?.mimeType || preferredMimeType || DEFAULT_MIME;
        recorder.addEventListener('dataavailable', handleChunk);
        recorder.addEventListener('error', async (event) => {
            console.error('MediaRecorder error', event.error);
            setStatus(`Recorder error: ${event.error?.message || event.error}`);
            await stopCapture();
        });
        recorder.addEventListener('stop', () => {
            mediaRecorderRef.current = null;
            if (captureStreamRef.current) {
                captureStreamRef.current.getTracks().forEach((track) => track.stop());
                captureStreamRef.current = null;
            }
        });
        chunkSequenceRef.current = 0;
        recorder.start(chunkTimeslice);
        pendingMessageIdRef.current = null;
        setMessages([]);
        setStatus('Capturing system audio…');
        setIsStreaming(true);
        setIsSelectingSource(false);
        streamingStateRef.current = true;
        selectingSourceRef.current = false;
    }, [attachTranscriptionEvents, chunkTimeslice, handleChunk, platform, stopCapture]);

    const startRecording = useCallback(async () => {
        if (!electronAPI?.getDesktopSources) {
            setStatus('Desktop capture API unavailable in preload.');
            return;
        }
        setIsSelectingSource(true);
        selectingSourceRef.current = true;
        setStatus('Requesting capture sources…');
        try {
            const sources = await electronAPI.getDesktopSources({ types: ['screen', 'window'] });
            setIsSelectingSource(false);
            selectingSourceRef.current = false;
            if (!sources?.length) {
                setStatus('No sources returned.');
                return;
            }
            await startStreamingWithSource(sources[0]);
        } catch (error) {
            console.error('Failed to list sources', error);
            setIsSelectingSource(false);
            selectingSourceRef.current = false;
            setStatus(`Failed to list sources: ${error?.message || 'Unknown error'}`);
        }
    }, [startStreamingWithSource]);

    const stopRecording = useCallback(async () => {
        setStatus('Stopping capture…');
        await stopCapture();
        setStatus('Idle');
    }, [stopCapture]);

    const scrollTranscriptBy = useCallback((delta) => {
        const el = transcriptRef.current;
        if (!el) {
            return;
        }
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        const nextTop = Math.min(maxScrollTop, Math.max(0, el.scrollTop + delta));
        el.scrollTo({ top: nextTop, behavior: 'smooth' });
        const atBottom = nextTop >= maxScrollTop - 2;
        setIsAtBottom(atBottom);
    }, []);

    const clearTranscript = useCallback(() => {
        pendingMessageIdRef.current = null;
        setMessages([]);
        if (transcriptRef.current) {
            transcriptRef.current.scrollTop = 0;
        }
        setIsAtBottom(true);
    }, []);

    useEffect(() => {
        if (!isControlWindow) {
            return () => {};
        }
        const registerToggle = electronAPI?.controlWindow?.onToggleCapture;
        if (typeof registerToggle !== 'function') {
            return () => {};
        }
        const unsubscribe = registerToggle(async () => {
            try {
                if (streamingStateRef.current || selectingSourceRef.current) {
                    await stopRecording();
                } else {
                    await startRecording();
                }
            } catch (error) {
                console.error('Failed to toggle capture via shortcut', error);
            }
        });
        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        };
    }, [isControlWindow, startRecording, stopRecording]);

    useEffect(() => {
        if (isControlWindow) {
            return () => {};
        }
        const api = electronAPI?.controlWindow;
        if (!api) {
            return () => {};
        }
        const unsubscribes = [];
        if (typeof api.onScrollUp === 'function') {
            unsubscribes.push(api.onScrollUp(() => {
                scrollTranscriptBy(-SCROLL_STEP_PX);
            }));
        }
        if (typeof api.onScrollDown === 'function') {
            unsubscribes.push(api.onScrollDown(() => {
                scrollTranscriptBy(SCROLL_STEP_PX);
            }));
        }
        if (typeof api.onClearTranscripts === 'function') {
            unsubscribes.push(api.onClearTranscripts(() => {
                clearTranscript();
            }));
        }
        return () => {
            unsubscribes.forEach((fn) => {
                if (typeof fn === 'function') {
                    fn();
                }
            });
        };
    }, [clearTranscript, isControlWindow, scrollTranscriptBy]);

    useEffect(() => {
        if (isControlWindow) {
            return () => {};
        }
        const el = transcriptRef.current;
        if (!el) {
            return () => {};
        }
        const handleScroll = () => {
            const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
            setIsAtBottom(atBottom);
        };
        handleScroll();
        el.addEventListener('scroll', handleScroll, { passive: true });
        return () => {
            el.removeEventListener('scroll', handleScroll);
        };
    }, [isControlWindow]);

    useEffect(() => {
        if (isControlWindow) {
            return () => {};
        }
        if (!isAtBottom) {
            return () => {};
        }
        const el = transcriptRef.current;
        if (!el) {
            return () => {};
        }
        const scrollToBottom = () => {
            const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
            el.scrollTo({ top: maxScrollTop, behavior: 'auto' });
        };
        // defer to next frame to ensure layout is ready
        const rafId = window.requestAnimationFrame(scrollToBottom);
        return () => window.cancelAnimationFrame(rafId);
    }, [isAtBottom, isControlWindow, messages]);

    useEffect(() => {
        if (!isControlWindow || typeof window === 'undefined') {
            return () => {};
        }
        const handleBeforeUnload = () => {
            stopCapture().catch(() => {});
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            stopCapture().catch(() => {});
        };
    }, [isControlWindow, stopCapture]);

    const canStart = !isStreaming && !isSelectingSource;
    const canStop = isStreaming;

    const renderControlStrip = () => {
        const startLabel = isSelectingSource ? 'Starting…' : 'Start';
        return (
            <div className="control-shell">
                <div className="control-strip" aria-live="polite">
                    <button
                        ref={controlStartRef}
                        className="control-button control-start"
                        type="button"
                        disabled={!canStart}
                        onClick={startRecording}
                    >
                        {startLabel}
                    </button>
                    <button
                        ref={controlStopRef}
                        className="control-button control-stop"
                        type="button"
                        disabled={!canStop}
                        onClick={stopRecording}
                    >
                        Stop
                    </button>
                </div>
            </div>
        );
    };

    const renderTranscriptPanel = () => (
        <div className="transcript-shell">
            <section className="transcript-panel" aria-live="polite">
                <header className="transcript-heading">
                    <span className={`state-dot ${isStreaming ? 'state-dot-live' : ''}`} aria-hidden="true" />
                    <span className="heading-chip">{isStreaming ? 'Streaming' : 'Idle'}</span>
                </header>
                <div className="transcript-body" ref={transcriptRef}>
                    <div className="chat-container">
                        {messages.length === 0 ? (
                            <div className="chat-placeholder">Transcription will appear here once capture starts.</div>
                        ) : (
                            messages.map((msg) => (
                                <ChatBubble
                                    key={msg.id}
                                    side={msg.side || 'left'}
                                    text={msg.text}
                                    isFinal={msg.isFinal}
                                />
                            ))
                        )}
                    </div>
                </div>
                <footer className="transcript-meta">
                    <span>{latencyStatus || `Chunk cadence ${chunkTimeslice} ms`}</span>
                </footer>
            </section>
        </div>
    );

    return isControlWindow ? renderControlStrip() : renderTranscriptPanel();
}

export default App;
