const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const statusLabel = document.getElementById('status');
const transcriptOutput = document.getElementById('transcript-output');

const electronAPI = typeof window !== 'undefined' ? (window.electronAPI || {}) : {};
const transcriptionAPI = electronAPI?.transcription;
const platform = typeof electronAPI?.getPlatform === 'function'
    ? electronAPI.getPlatform()
    : 'unknown';
const CHUNK_TIMESLICE_MS = typeof electronAPI?.getChunkTimesliceMs === 'function'
    ? Number(electronAPI.getChunkTimesliceMs())
    : 200;
const DEFAULT_MIME = 'audio/webm;codecs=opus';
const CONTINUATION_LINGER_MS = 2500;
const STALL_THRESHOLD_MS = 1500;
const STALL_WATCH_INTERVAL_MS = 1000;

console.debug('Using CHUNK_TIMESLICE_MS =', CHUNK_TIMESLICE_MS);

const resolvePreferredMimeType = () => {
    if (typeof MediaRecorder?.isTypeSupported !== 'function') {
        return '';
    }
    const candidates = [
        'audio/ogg;codecs=opus',
        'audio/webm;codecs=opus',
        'audio/webm'
    ];
    return candidates.find((candidate) => {
        try {
            return MediaRecorder.isTypeSupported(candidate);
        } catch (_error) {
            return false;
        }
    }) || '';
};

const preferredMimeType = resolvePreferredMimeType();

const buildRecorderOptions = (mimeType) => (mimeType ? { mimeType } : {});

const buildVideoConstraints = (sourceId) => ({
    mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId
    }
});

const buildAudioConstraints = (sourceId) => {
    return {
        mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
        }
    };
};

const mergeText = (base, incoming, preferAppend = false) => {
    const safeBase = base || '';
    const safeIncoming = incoming || '';
    if (!safeIncoming) return safeBase;
    if (!safeBase) return safeIncoming;
    if (safeIncoming === safeBase) return safeBase;

    const baseTrimRight = preferAppend
        ? safeBase
        : safeBase.replace(/\s+$/g, '');
    const incomingTrimLeft = preferAppend
        ? safeIncoming
        : safeIncoming.replace(/^\s+/g, '');

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
    return `${baseTrimRight}${needsSpace ? ' ' : ''}${remainder}`;
};

const formatStalledLabel = (durationMs) => {
    const seconds = Math.max(1, Math.round(Math.max(0, durationMs) / 1000));
    return `(stalled ${seconds}s)`;
};

let mediaRecorder = null;
let captureStream = null;
let sessionId = null;
let stopTranscriptionListener = null;
let chunkSequence = 0;
let recordingMimeType = preferredMimeType || DEFAULT_MIME;
let awaitingSourceSelection = false;

let latencyWatchdogTimer = null;
let lastLatencyLabel = '';
let lastLatencyUpdateTs = 0;
let latencySuffixLabel = '';
let latencySuffixReason = '';

let bubbleIdCounter = 0;
let pendingBubbleId = null;
let continuationBubbleId = null;
let lastBubbleUpdateTs = 0;

const clearTranscriptBubbles = () => {
    if (!transcriptOutput) {
        return;
    }
    transcriptOutput.innerHTML = '';
    pendingBubbleId = null;
    continuationBubbleId = null;
    lastBubbleUpdateTs = 0;
};

const ensurePlaceholder = () => {
    if (!transcriptOutput) {
        return;
    }
    if (transcriptOutput.childElementCount === 0) {
        const placeholder = document.createElement('div');
        placeholder.className = 'chat-placeholder';
        placeholder.textContent = 'Transcription will appear here once capture starts.';
        transcriptOutput.appendChild(placeholder);
    }
};

const removePlaceholder = () => {
    if (!transcriptOutput) {
        return;
    }
    const placeholder = transcriptOutput.querySelector('.chat-placeholder');
    if (placeholder) {
        transcriptOutput.removeChild(placeholder);
    }
};

const createBubbleElement = (id, text, side) => {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${side === 'right' ? 'right' : 'left'}`;
    bubble.dataset.messageId = id;
    bubble.dataset.final = 'false';
    bubble.textContent = text || '';
    return bubble;
};

const upsertBubble = ({ text, isFinal, side = 'left', append = false }) => {
    if (!transcriptOutput) {
        return;
    }
    if (!text && !isFinal) {
        return;
    }

    removePlaceholder();

    const now = Date.now();
    const canContinue = continuationBubbleId
        && lastBubbleUpdateTs
        && (now - lastBubbleUpdateTs) <= CONTINUATION_LINGER_MS;
    const targetId = pendingBubbleId || (canContinue ? continuationBubbleId : null);
    if (!canContinue) {
        continuationBubbleId = null;
    }
    const safeText = text || '';

    if (!isFinal) {
        if (targetId) {
            const node = transcriptOutput.querySelector(`[data-message-id=\"${targetId}\"]`);
            if (node) {
                if (append && safeText) {
                    node.textContent = mergeText(node.textContent, safeText, append);
                } else if (safeText) {
                    node.textContent = safeText;
                }
            }
            pendingBubbleId = targetId;
            continuationBubbleId = targetId;
            lastBubbleUpdateTs = now;
            return;
        }
        const id = `msg-${Date.now()}-${bubbleIdCounter += 1}`;
        pendingBubbleId = id;
        continuationBubbleId = id;
        lastBubbleUpdateTs = now;
        transcriptOutput.appendChild(createBubbleElement(id, safeText, side));
        transcriptOutput.scrollTop = transcriptOutput.scrollHeight;
        return;
    }

    if (targetId) {
        const node = transcriptOutput.querySelector(`[data-message-id=\"${targetId}\"]`);
        pendingBubbleId = null;
        continuationBubbleId = targetId;
        lastBubbleUpdateTs = now;
        if (node) {
            if (append && safeText) {
                const mergedText = mergeText(node.textContent, safeText, append);
                node.textContent = mergedText || node.textContent;
            } else if (safeText) {
                node.textContent = safeText;
            }
            node.dataset.final = 'true';
            transcriptOutput.scrollTop = transcriptOutput.scrollHeight;
            return;
        }
    }

    const id = `msg-${Date.now()}-${bubbleIdCounter += 1}`;
    pendingBubbleId = null;
    continuationBubbleId = id;
    lastBubbleUpdateTs = now;
    const bubble = createBubbleElement(id, safeText, side);
    bubble.dataset.final = 'true';
    transcriptOutput.appendChild(bubble);
    transcriptOutput.scrollTop = transcriptOutput.scrollHeight;
};

const updateStatus = (message) => {
    if (!statusLabel) {
        return;
    }
    statusLabel.textContent = message;
};

const updateButtonStates = ({ isFetching = false } = {}) => {
    if (!startButton || !stopButton) {
        return;
    }
    const isStreaming = Boolean(mediaRecorder && mediaRecorder.state !== 'inactive');
    const busy = isFetching || awaitingSourceSelection;
    startButton.disabled = busy || isStreaming;
    stopButton.disabled = !isStreaming;
};

const resetTranscriptionListener = () => {
    if (typeof stopTranscriptionListener === 'function') {
        stopTranscriptionListener();
    }
    stopTranscriptionListener = null;
};

const teardownSession = async () => {
    if (sessionId && transcriptionAPI?.stopSession) {
        try {
            await transcriptionAPI.stopSession(sessionId);
        } catch (_error) {
            // ignore cleanup failures
        }
    }
    sessionId = null;
    resetTranscriptionListener();
    clearTranscriptBubbles();
    ensurePlaceholder();
    resetLatencyWatchdog();
};

const stopCapture = async () => {
    if (mediaRecorder) {
        try {
            mediaRecorder.stop();
        } catch (_error) {
            // ignore
        }
        mediaRecorder = null;
    }
    if (captureStream) {
        captureStream.getTracks().forEach((track) => track.stop());
        captureStream = null;
    }
    chunkSequence = 0;
    recordingMimeType = preferredMimeType || DEFAULT_MIME;
    awaitingSourceSelection = false;
    await teardownSession();
    updateButtonStates();
};

const handleChunk = async (event) => {
    if (!event?.data?.size || !sessionId || !transcriptionAPI?.sendChunk) {
        return;
    }

    try {
        const sequence = chunkSequence;
        chunkSequence += 1;
        const arrayBuffer = await event.data.arrayBuffer();
        const captureTimestamp = Date.now();
        transcriptionAPI.sendChunk({
            sessionId,
            sequence,
            mimeType: recordingMimeType,
            data: arrayBuffer,
            timestamp: captureTimestamp,
            captureTimestamp
        });
    } catch (error) {
        console.error('Failed to dispatch audio chunk', error);
    }
};

const attachTranscriptionEvents = () => {
    if (typeof transcriptionAPI?.onEvent !== 'function') {
        return;
    }
    resetTranscriptionListener();
    stopTranscriptionListener = transcriptionAPI.onEvent((payload = {}) => {
        if (!sessionId || payload.sessionId !== sessionId) {
            return;
        }

        switch (payload.type) {
            case 'started':
                ensureLatencyWatchdog();
                lastLatencyLabel = '';
                lastLatencyUpdateTs = Date.now();
                latencySuffixLabel = '';
                latencySuffixReason = '';
                updateStatus('Streaming transcription active.');
                break;
            case 'update': {
                const serverText = typeof payload.text === 'string' ? payload.text : '';
                const delta = typeof payload.delta === 'string' ? payload.delta : '';
                const isFinal = Boolean(payload.isFinal);
                const content = delta || serverText;
                if (content) {
                    upsertBubble({ text: content, isFinal, side: 'left', append: Boolean(delta) });
                }
                lastLatencyUpdateTs = Date.now();
                lastLatencyLabel = `WS ${payload.latencyMs ?? '-'}ms | E2E ${payload.pipelineMs ?? '-'}ms | CONV ${payload.conversionMs ?? '-'}ms`;
                latencySuffixLabel = '';
                latencySuffixReason = '';
                ensureLatencyWatchdog();
                renderLatencyStatus();
                break;
            }
            case 'warning':
                console.warn('[Transcription warning]', payload);
                resetLatencyWatchdog();
                latencySuffixLabel = '';
                latencySuffixReason = '';
                updateStatus(`Transcription warning: ${resolveWarningMessage(payload)}`);
                break;
            case 'error':
                resetLatencyWatchdog();
                latencySuffixLabel = '';
                latencySuffixReason = '';
                updateStatus(`Transcription error: ${payload.error?.message || 'Unknown error'}`);
                break;
            case 'stopped':
                resetLatencyWatchdog();
                latencySuffixLabel = '';
                latencySuffixReason = '';
                updateStatus('Transcription session stopped.');
                clearTranscriptBubbles();
                ensurePlaceholder();
                break;
            case 'heartbeat': {
                const state = payload.state || (payload.silent ? 'silence' : 'speech');
                if (state === 'reconnecting') {
                    latencySuffixLabel = '(reconnecting…)';
                    latencySuffixReason = 'reconnecting';
                } else if (state === 'reconnected') {
                    latencySuffixLabel = '(reconnected)';
                    latencySuffixReason = 'reconnected';
                } else if (state === 'silence') {
                    const duration = Math.max(0, Number(payload.silenceDurationMs) || 0);
                    latencySuffixLabel = formatStalledLabel(duration);
                    latencySuffixReason = 'heartbeat-silence';
                } else if (state === 'speech') {
                    if (latencySuffixReason === 'heartbeat-silence') {
                        latencySuffixLabel = '';
                        latencySuffixReason = '';
                    }
                } else if (latencySuffixReason !== 'stall') {
                    latencySuffixLabel = '';
                    latencySuffixReason = '';
                }
                renderLatencyStatus();
                break;
            }
            default:
                break;
        }
    });
};

const startStreamingWithSource = async (source) => {
    const sourceId = source?.id;
    if (!sourceId) {
        updateStatus('No valid source selected.');
        updateButtonStates();
        return;
    }
    if (!transcriptionAPI?.startSession) {
        updateStatus('Transcription API unavailable.');
        updateButtonStates();
        return;
    }

    updateButtonStates({ isFetching: true });
    updateStatus('Preparing capture stream…');

    const videoConstraints = buildVideoConstraints(sourceId);
    const audioConstraints = buildAudioConstraints(sourceId);

    try {
        captureStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: videoConstraints
        });
    } catch (error) {
        console.error('Failed to obtain capture stream', error);
        updateStatus(`Failed to capture system audio: ${error?.message || error}`);
        updateButtonStates({ isFetching: false });
        return;
    }

    const audioTracks = captureStream.getAudioTracks();
    if (!audioTracks.length) {
        updateStatus('No system audio track detected.');
        updateButtonStates({ isFetching: false });
        return;
    }

    const audioStream = new MediaStream(audioTracks);

    let sessionResponse;
    try {
        sessionResponse = await transcriptionAPI.startSession({
            sourceName: source.name || source.id,
            platform
        });
    } catch (error) {
        console.error('Failed to start transcription session', error);
        updateStatus(`Transcription unavailable: ${error?.message || 'unknown error'}`);
        await stopCapture();
        updateButtonStates({ isFetching: false });
        return;
    }

    sessionId = sessionResponse?.sessionId || null;
    attachTranscriptionEvents();

    const recorderOptions = buildRecorderOptions(preferredMimeType);
    try {
        mediaRecorder = new MediaRecorder(audioStream, recorderOptions);
    } catch (error) {
        console.warn('MediaRecorder error when applying preferred mime type', recorderOptions, error);
        mediaRecorder = new MediaRecorder(audioStream);
    }

    recordingMimeType = mediaRecorder.mimeType || preferredMimeType || DEFAULT_MIME;

    mediaRecorder.addEventListener('dataavailable', handleChunk);
    mediaRecorder.addEventListener('error', async (event) => {
        console.error('MediaRecorder error', event.error);
        updateStatus(`Recorder error: ${event.error?.message || event.error}`);
        await stopCapture();
        updateButtonStates();
    });
    mediaRecorder.addEventListener('stop', () => {
        mediaRecorder = null;
        if (captureStream) {
            captureStream.getTracks().forEach((track) => track.stop());
            captureStream = null;
        }
    });

    chunkSequence = 0;
    mediaRecorder.start(CHUNK_TIMESLICE_MS);
    clearTranscriptBubbles();
    ensurePlaceholder();
    updateStatus('Capturing system audio…');
    updateButtonStates({ isFetching: false });
};

const promptSourceSelection = async () => {
    if (typeof electronAPI?.getDesktopSources !== 'function') {
        updateStatus('Desktop capture API unavailable in preload.');
        return;
    }
    awaitingSourceSelection = true;
    updateButtonStates();

    try {
        const sources = await electronAPI.getDesktopSources({ types: ['screen', 'window'] });
        awaitingSourceSelection = false;
        updateButtonStates();

        if (!sources?.length) {
            updateStatus('No sources returned.');
            return;
        }

        await startStreamingWithSource(sources[0]);
    } catch (error) {
        awaitingSourceSelection = false;
        console.error('Failed to list sources', error);
        updateStatus(`Failed to list sources: ${error?.message || 'Unknown error'}`);
        updateButtonStates();
    }
};

if (startButton) {
    startButton.addEventListener('click', promptSourceSelection);
}

if (stopButton) {
    stopButton.addEventListener('click', async () => {
        updateStatus('Stopping capture…');
        await stopCapture();
        updateStatus('Idle');
        updateButtonStates();
    });
}

window.addEventListener('beforeunload', () => {
    stopCapture().catch(() => { });
});

updateButtonStates();
updateStatus('Idle');
ensurePlaceholder();

if (import.meta?.hot) {
    import.meta.hot.accept(() => {
        window.location.reload();
    });
}

function ensureLatencyWatchdog() {
    if (latencyWatchdogTimer) {
        return;
    }
    latencyWatchdogTimer = setInterval(() => {
        if (!sessionId || !lastLatencyLabel || !lastLatencyUpdateTs) {
            return;
        }
        const stalledFor = Date.now() - lastLatencyUpdateTs;
        if (stalledFor >= STALL_THRESHOLD_MS && latencySuffixReason !== 'heartbeat-silence') {
            latencySuffixLabel = formatStalledLabel(stalledFor);
            latencySuffixReason = 'stall';
            renderLatencyStatus();
        }
    }, STALL_WATCH_INTERVAL_MS);
}

function resetLatencyWatchdog() {
    lastLatencyLabel = '';
    lastLatencyUpdateTs = 0;
    latencySuffixLabel = '';
    latencySuffixReason = '';
    if (latencyWatchdogTimer) {
        clearInterval(latencyWatchdogTimer);
        latencyWatchdogTimer = null;
    }
}

function renderLatencyStatus(overrideSuffix = null) {
    const suffix = overrideSuffix ?? latencySuffixLabel;
    if (!lastLatencyLabel && !suffix) {
        return;
    }
    if (!lastLatencyLabel) {
        updateStatus((suffix || '').trim() || 'Streaming transcription active.');
        return;
    }
    const extra = suffix ? ` ${suffix}` : '';
    updateStatus(`Latency ${lastLatencyLabel}${extra}`);
}

function resolveWarningMessage(payload = {}) {
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
}
