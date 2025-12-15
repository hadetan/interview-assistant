import { useEffect, useMemo, useRef } from 'react';
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
        getSessionId
    } = session;

    const sessionApi = useMemo(() => ({
        setStatus,
        attachTranscriptionEvents,
        startTranscriptionSession,
        teardownSession,
        clearTranscript,
        getSessionId
    }), [
        attachTranscriptionEvents,
        clearTranscript,
        getSessionId,
        setStatus,
        startTranscriptionSession,
        teardownSession
    ]);

    const { isSelectingSource, isRecording, startRecording, stopRecording } = useRecorder({
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
            </div>
        </div>
    );
}
