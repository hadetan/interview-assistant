const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const statusLabel = document.getElementById('status');
const transcriptOutput = document.getElementById('transcript-output');

const platform = window.electronAPI.getPlatform();
// Read chunk timeslice from preload-exposed env getter with defaults/validation
const CHUNK_TIMESLICE_MS = (typeof window.electronAPI?.getChunkTimesliceMs === 'function')
    ? Number(window.electronAPI.getChunkTimesliceMs())
    : 200;
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

const buildRecorderOptions = () => {
    if (!preferredMimeType) {
        return {};
    }
    return { mimeType: preferredMimeType };
};

let mediaRecorder = null;
let captureStream = null;
let sessionId = null;
let chunkSequence = 0;
let awaitingSourceSelection = false;
let stopTranscriptionListener = null;
let recordingMimeType = preferredMimeType || 'audio/webm;codecs=opus';
let lastLatencyLabel = '';
let lastLatencyUpdateTs = 0;
let latencyWatchdogTimer = null;
const STALL_THRESHOLD_MS = 5000;
const STALL_WATCH_INTERVAL_MS = 1000;
let localTranscript = '';

function appendWithOverlap(base, incoming) {
    if (!base) return incoming || '';
    if (!incoming) return base || '';

    // Find largest overlap where base suffix equals incoming prefix
    const maxOverlap = Math.min(base.length, incoming.length);
    for (let k = maxOverlap; k > 0; k -= 1) {
        try {
            if (base.slice(base.length - k) === incoming.slice(0, k)) {
                return base + incoming.slice(k);
            }
        } catch (err) {
            // ignore and continue
        }
    }

    // No overlap detected; decide if we should insert a separating space.
    // Rules:
    //  - If base ends with whitespace OR incoming starts with whitespace => no insert
    //  - If base ends with sentence punctuation (.,!?\n) => insert a space
    //  - If incoming starts with an uppercase letter => insert a space (likely new sentence)
    //  - Otherwise, append directly (to avoid inserting spaces inside words)
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

    // If both sides look like full words (not single-letter fragments), and they are alphanumeric,
    // insert a separator so two words don't get concatenated without spaces (e.g., "Hello world" + "there").
    const lastSpaceIdx = base.lastIndexOf(' ');
    const lastToken = lastSpaceIdx >= 0 ? base.slice(lastSpaceIdx + 1) : base;
    const incomingFirstToken = incomingTrimLeft.split(/\s+/)[0] || '';

    // If base has a space (the last token is preceded by a space), and that
    // last token is reasonably long (>2), assume it's a full word and we should
    // insert a space between it and the incoming if the incoming also appears to
    // start a word.
    if (lastSpaceIdx >= 0) {
        if (isIncomingPunctuation) {
            return base + incomingTrimLeft;
        }
        if (lastToken.length > 2 && incomingFirstToken.length > 0) {
            return base + ' ' + incomingTrimLeft;
        }
        // short token (likely a fragment) — fall through: avoid inserting a space
        return base + incoming;
    }

    // No spaces in base (single token so far). If base token length is large,
    // it's likely a whole word and the incoming token should be separated.
    if (lastToken.length > 3 && incomingFirstToken.length > 1) {
        return base + ' ' + incomingTrimLeft;
    }

    // Default: append directly to preserve continuity for partial words
    return base + incoming;
}

const updateStatus = (message) => {
    statusLabel.textContent = message;
};

const updateTranscript = (text) => {
    transcriptOutput.textContent = text || '';
};

const updateButtonStates = ({ isFetching = false } = {}) => {
    const isStreaming = Boolean(mediaRecorder && mediaRecorder.state !== 'inactive');
    const busy = isFetching || awaitingSourceSelection;
    startButton.disabled = busy || isStreaming;
    stopButton.disabled = !isStreaming;
};

const resetTranscriptionListener = () => {
    if (typeof stopTranscriptionListener === 'function') {
        stopTranscriptionListener();
        stopTranscriptionListener = null;
    }
};

const teardownSession = async () => {
    if (sessionId) {
        await window.electronAPI.transcription.stopSession(sessionId).catch(() => {});
        sessionId = null;
    }
    resetTranscriptionListener();
    updateTranscript('');
    resetLatencyWatchdog();
    // clear local cached transcript state
    localTranscript = '';
};

const stopCapture = async () => {
    if (mediaRecorder) {
        mediaRecorder.stop();
        mediaRecorder = null;
    }
    if (captureStream) {
        captureStream.getTracks().forEach((track) => track.stop());
        captureStream = null;
    }
    await teardownSession();
    chunkSequence = 0;
    recordingMimeType = preferredMimeType || 'audio/webm;codecs=opus';
};

const buildVideoConstraints = (sourceId) => ({
    mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId
    }
});

const buildAudioConstraints = (sourceId) => {
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

const handleChunk = async (event) => {
    if (!event?.data?.size || !sessionId) {
        return;
    }

    try {
        const sequence = chunkSequence;
        chunkSequence += 1;
        const arrayBuffer = await event.data.arrayBuffer();
        const captureTimestamp = Date.now();
        window.electronAPI.transcription.sendChunk({
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
    resetTranscriptionListener();
    stopTranscriptionListener = window.electronAPI.transcription.onEvent((payload = {}) => {
        if (!sessionId || payload.sessionId !== sessionId) {
            return;
        }

        switch (payload.type) {
            case 'started':
                ensureLatencyWatchdog();
                lastLatencyLabel = '';
                lastLatencyUpdateTs = Date.now();
                updateStatus('Streaming transcription active.');
                break;
            case 'update': {
                const serverText = typeof payload.text === 'string' ? payload.text : '';
                const delta = typeof payload.delta === 'string' ? payload.delta : '';
                if (delta) {
                    localTranscript = appendWithOverlap(localTranscript, delta);
                } else if (serverText) {
                    localTranscript = appendWithOverlap(localTranscript, serverText);
                }
                updateTranscript(localTranscript || '');
                lastLatencyUpdateTs = Date.now();
                lastLatencyLabel = `WS ${payload.latencyMs ?? '-'}ms | E2E ${payload.pipelineMs ?? '-'}ms | CONV ${payload.conversionMs ?? '-'}ms`;
                ensureLatencyWatchdog();
                renderLatencyStatus();
                break;
            }
            case 'warning':
                console.warn('[Transcription warning]', payload);
                resetLatencyWatchdog();
                updateStatus(`Transcription warning: ${resolveWarningMessage(payload)}`);
                break;
            case 'error':
                resetLatencyWatchdog();
                updateStatus(`Transcription error: ${payload.error?.message || 'Unknown error'}`);
                break;
            case 'stopped':
                resetLatencyWatchdog();
                updateStatus('Transcription session stopped.');
                // clear cached transcript state when service signals stop
                localTranscript = '';
                break;
            default:
                break;
        }
    });
};

const startStreamingWithSource = async (source) => {
    const sourceId = source?.id;
    if (!sourceId) {
        updateStatus('No valid source selected.');
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
        sessionResponse = await window.electronAPI.transcription.startSession({
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
    sessionId = sessionResponse.sessionId;
    attachTranscriptionEvents();

    const recorderOptions = buildRecorderOptions();
    try {
        mediaRecorder = new MediaRecorder(audioStream, recorderOptions);
    } catch (error) {
        console.error('MediaRecorder error when applying preferred mime type', recorderOptions, error);
        mediaRecorder = new MediaRecorder(audioStream);
    }

    recordingMimeType = mediaRecorder.mimeType || preferredMimeType || 'audio/webm;codecs=opus';

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
    // reset transcript cache for a new session
    localTranscript = '';
    updateStatus('Capturing system audio…');
    updateButtonStates({ isFetching: false });
};

const promptSourceSelection = async () => {
    awaitingSourceSelection = true;
    updateButtonStates({ isFetching: true });

    try {
        const sources = await window.electronAPI.getDesktopSources({ types: ['screen', 'window'] });
        awaitingSourceSelection = false;

        if (!sources?.length) {
            updateStatus('No sources returned.');
            return;
        }

        await startStreamingWithSource(sources[0]);
    } catch (error) {
        awaitingSourceSelection = false;
        console.error('Failed to list sources', error);
        updateStatus(`Failed to list sources: ${error?.message || 'Unknown error'}`);
    } finally {
        updateButtonStates({ isFetching: false });
    }
};

startButton.addEventListener('click', promptSourceSelection);
stopButton.addEventListener('click', async () => {
    updateStatus('Stopping capture…');
    await stopCapture();
    updateStatus('Idle');
    updateButtonStates();
});

window.addEventListener('beforeunload', () => {
    stopCapture().catch(() => {});
});

updateButtonStates();
updateStatus('Idle');

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
        if (stalledFor >= STALL_THRESHOLD_MS) {
            const seconds = Math.max(1, Math.floor(stalledFor / 1000));
            renderLatencyStatus(`(stalled ${seconds}s)`);
        }
    }, STALL_WATCH_INTERVAL_MS);
}

function resetLatencyWatchdog() {
    lastLatencyLabel = '';
    lastLatencyUpdateTs = 0;
    if (latencyWatchdogTimer) {
        clearInterval(latencyWatchdogTimer);
        latencyWatchdogTimer = null;
    }
}

function renderLatencyStatus(suffix = '') {
    if (!lastLatencyLabel) {
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
