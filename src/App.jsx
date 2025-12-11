import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;
const DEFAULT_MIME = 'audio/webm;codecs=opus';
const STALL_THRESHOLD_MS = 5000;
const STALL_WATCH_INTERVAL_MS = 1000;

const appendWithOverlap = (base = '', incoming = '') => {
    if (!base) return incoming || '';
    if (!incoming) return base || '';
    const maxOverlap = Math.min(base.length, incoming.length);
    for (let k = maxOverlap; k > 0; k -= 1) {
        if (base.slice(base.length - k) === incoming.slice(0, k)) {
            return base + incoming.slice(k);
        }
    }
    const rTrimmed = base.replace(/\s+$/, '');
    const baseLastChar = rTrimmed.length ? rTrimmed[rTrimmed.length - 1] : '';
    const incomingTrimLeft = incoming.replace(/^\s+/, '');
    const incomingFirstChar = incomingTrimLeft.length ? incomingTrimLeft[0] : '';
    const isBaseWhitespaceEnding = /\s$/.test(base);
    const isIncomingWhitespaceStarting = /^\s/.test(incoming);
    const isBaseSentencePunct = /[.!?\n]/.test(baseLastChar);
    const isIncomingUppercase = /[A-Z]/.test(incomingFirstChar);
    const isIncomingPunctuation = /^[.,!?:;"'()\[\]{}]/.test(incomingFirstChar);
    if (isBaseWhitespaceEnding || isIncomingWhitespaceStarting) {
        return base + incoming;
    }
    if (isBaseSentencePunct || (isIncomingUppercase && !isIncomingPunctuation)) {
        return base + ' ' + incomingTrimLeft;
    }
    const lastSpaceIdx = base.lastIndexOf(' ');
    const lastToken = lastSpaceIdx >= 0 ? base.slice(lastSpaceIdx + 1) : base;
    const incomingFirstToken = incomingTrimLeft.split(/\s+/)[0] || '';
    if (lastSpaceIdx >= 0) {
        if (isIncomingPunctuation) {
            return base + incomingTrimLeft;
        }
        if (lastToken.length > 2 && incomingFirstToken.length > 0) {
            return base + ' ' + incomingTrimLeft;
        }
        return base + incoming;
    }
    if (lastToken.length > 3 && incomingFirstToken.length > 1) {
        return base + ' ' + incomingTrimLeft;
    }
    return base + incoming;
};

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
    const [transcript, setTranscript] = useState('');
    const [isSelectingSource, setIsSelectingSource] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [latencyStatus, setLatencyStatus] = useState('');

    const windowVariant = useMemo(() => resolveWindowVariant(), []);
    const isControlWindow = windowVariant === WINDOW_VARIANTS.CONTROL;

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
    const localTranscriptRef = useRef('');
    const latencyTimerRef = useRef(null);
    const lastLatencyTsRef = useRef(0);
    const latencyLabelRef = useRef('');
    const controlStartRef = useRef(null);
    const controlStopRef = useRef(null);
    const streamingStateRef = useRef(false);
    const selectingSourceRef = useRef(false);

    const resetTranscriptionListener = useCallback(() => {
        if (typeof stopTranscriptionListenerRef.current === 'function') {
            stopTranscriptionListenerRef.current();
        }
        stopTranscriptionListenerRef.current = null;
    }, []);

    const updateLatencyStatus = useCallback((suffix = '') => {
        if (!latencyLabelRef.current) {
            setLatencyStatus('');
            return;
        }
        const extra = suffix ? ` ${suffix}` : '';
        setLatencyStatus(`Latency ${latencyLabelRef.current}${extra}`);
    }, []);

    const resetLatencyWatchdog = useCallback(() => {
        if (latencyTimerRef.current) {
            clearInterval(latencyTimerRef.current);
            latencyTimerRef.current = null;
        }
        lastLatencyTsRef.current = 0;
        latencyLabelRef.current = '';
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
            if (stalledFor >= STALL_THRESHOLD_MS) {
                const seconds = Math.max(1, Math.floor(stalledFor / 1000));
                updateLatencyStatus(`(stalled ${seconds}s)`);
            }
        }, STALL_WATCH_INTERVAL_MS);
    }, [updateLatencyStatus]);

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
        localTranscriptRef.current = '';
        setTranscript('');
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
                    setStatus('Streaming transcription active.');
                    setIsStreaming(true);
                    streamingStateRef.current = true;
                    selectingSourceRef.current = false;
                    break;
                case 'update': {
                    const serverText = typeof payload.text === 'string' ? payload.text : '';
                    const delta = typeof payload.delta === 'string' ? payload.delta : '';
                    if (delta) {
                        localTranscriptRef.current = appendWithOverlap(localTranscriptRef.current, delta);
                    } else if (serverText) {
                        localTranscriptRef.current = appendWithOverlap(localTranscriptRef.current, serverText);
                    }
                    setTranscript(localTranscriptRef.current);
                    lastLatencyTsRef.current = Date.now();
                    latencyLabelRef.current = `WS ${payload.latencyMs ?? '-'}ms | E2E ${payload.pipelineMs ?? '-'}ms | CONV ${payload.conversionMs ?? '-'}ms`;
                    ensureLatencyWatchdog();
                    updateLatencyStatus();
                    break;
                }
                case 'warning':
                    resetLatencyWatchdog();
                    setStatus(`Transcription warning: ${resolveWarningMessage(payload)}`);
                    break;
                case 'error':
                    resetLatencyWatchdog();
                    setStatus(`Transcription error: ${payload.error?.message || 'Unknown error'}`);
                    break;
                case 'stopped':
                    resetLatencyWatchdog();
                    setStatus('Transcription session stopped.');
                    localTranscriptRef.current = '';
                    setTranscript('');
                    setIsStreaming(false);
                    streamingStateRef.current = false;
                    if (!isControlWindow) {
                        sessionIdRef.current = null;
                    }
                    break;
                default:
                    break;
            }
        });
    }, [ensureLatencyWatchdog, isControlWindow, resetLatencyWatchdog, resetTranscriptionListener, updateLatencyStatus]);

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
        localTranscriptRef.current = '';
        setTranscript('');
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
                        disabled={!canStart}
                    >
                        {startLabel}
                    </button>
                    <button
                        ref={controlStopRef}
                        className="control-button control-stop"
                        disabled={!canStop}
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
                <div className="transcript-body">
                    {transcript || 'Transcription will appear here once capture starts.'}
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
