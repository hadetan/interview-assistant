import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useRecorder } from '../hooks/useRecorder';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;

export default function ControlWindow({
    session,
    chunkTimeslice,
    preferredMimeType,
    platform
}) {
    const {
        setStatus,
        attachTranscriptionEvents,
        startTranscriptionSession,
        teardownSession,
        clearTranscript,
        getSessionId,
        startSourceSession,
        stopSourceSession,
        isSourceStreaming
    } = session;

    const sessionApi = useMemo(() => ({
        setStatus,
        attachTranscriptionEvents,
        startTranscriptionSession,
        teardownSession,
        clearTranscript,
        getSessionId,
        startSourceSession,
        stopSourceSession,
        isSourceStreaming
    }), [
        attachTranscriptionEvents,
        clearTranscript,
        getSessionId,
        isSourceStreaming,
        setStatus,
        startTranscriptionSession,
        startSourceSession,
        stopSourceSession,
        teardownSession
    ]);

    const {
        isSelectingSource,
        isRecording,
        startRecording,
        stopRecording,
        toggleMic,
        mic
    } = useRecorder({
        chunkTimeslice,
        platform,
        preferredMimeType,
        sessionApi
    });

    const streamingStateRef = useRef(false);
    const selectingSourceRef = useRef(false);

    useEffect(() => {
        streamingStateRef.current = isRecording;
    }, [isRecording]);

    useEffect(() => {
        selectingSourceRef.current = isSelectingSource;
    }, [isSelectingSource]);

    const micButtonLabel = useMemo(() => {
        if (!isRecording) {
            return 'Mic (start system first)';
        }
        if (mic.isPending) {
            if (mic.pendingAction === 'stopping') {
                return 'Stopping Mic…';
            }
            return 'Starting Mic…';
        }
        if (!mic.isReady) {
            return 'Mic unavailable';
        }
        return mic.isActive ? 'Stop Mic' : 'Start Mic';
    }, [isRecording, mic]);

    const isMicButtonDisabled = useMemo(() => {
        if (!isRecording) {
            return true;
        }
        if (mic.isPending) {
            return true;
        }
        return !mic.isReady;
    }, [isRecording, mic]);

    const micStatusMessage = useMemo(() => {
        if (!isRecording) {
            return 'Start system capture to enable microphone streaming.';
        }
        if (mic.isPending) {
            return '';
        }
        if (mic.error) {
            return mic.error;
        }
        if (!mic.isReady && !mic.isPending) {
            return 'Awaiting microphone permission…';
        }
        return '';
    }, [isRecording, mic]);

    const handleMicToggle = useCallback(async () => {
        if (isMicButtonDisabled) {
            return;
        }
        try {
            await toggleMic();
        } catch (error) {
            console.error('Failed to toggle microphone capture', error);
        }
    }, [isMicButtonDisabled, toggleMic]);

    useEffect(() => {
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
    }, [startRecording, stopRecording]);

    useEffect(() => {
        if (typeof window === 'undefined') {
            return () => {};
        }
        const handleBeforeUnload = () => {
            stopRecording().catch(() => {});
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            stopRecording().catch(() => {});
        };
    }, [stopRecording]);

    const startLabel = useMemo(() => (isSelectingSource ? 'Starting…' : 'Start'), [isSelectingSource]);
    const canStart = !isRecording && !isSelectingSource;
    const canStop = isRecording;

    return (
        <div className="control-shell">
            <div className="control-strip" aria-live="polite">
                <button
                    className="control-button control-start"
                    type="button"
                    disabled={!canStart}
                    onClick={startRecording}
                >
                    {startLabel}
                </button>
                <button
                    className="control-button control-stop"
                    type="button"
                    disabled={!canStop}
                    onClick={stopRecording}
                >
                    Stop
                </button>
                <button
                    className={`control-button control-mic${mic.isActive ? ' control-mic-active' : ''}`}
                    type="button"
                    disabled={isMicButtonDisabled}
                    onClick={handleMicToggle}
                >
                    {micButtonLabel}
                </button>
            </div>
            {micStatusMessage ? (
                <div
                    className={`control-hint ${mic.error ? 'control-hint-error' : ''}`}
                    role="status"
                    aria-live="polite"
                >
                    {micStatusMessage}
                </div>
            ) : null}
        </div>
    );
}
