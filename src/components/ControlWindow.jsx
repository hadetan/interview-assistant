import { cloneElement, useCallback, useEffect, useMemo, useRef } from 'react';
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
        if (mic.isPending) {
            if (mic.pendingAction === 'stopping') {
                return 'Stopping Mic…';
            }
            return 'Starting Mic…';
        }
        return mic.isActive ? 'Stop Mic' : 'Start Mic';
    }, [mic]);

    const isMicButtonDisabled = useMemo(() => {
        if (!isRecording) {
            return true;
        }
        return mic.isPending;
    }, [isRecording, mic]);

    useMemo(() => {
        if (mic.error) {
            console.error(mic.error);
        }
        return '';
    }, [mic]);

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
        const registerMicToggle = electronAPI?.controlWindow?.onToggleMic;
        if (typeof registerMicToggle !== 'function') {
            return () => {};
        }
        const unsubscribe = registerMicToggle(() => {
            handleMicToggle();
        });
        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        };
    }, [handleMicToggle]);

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
        </div>
    );
}
