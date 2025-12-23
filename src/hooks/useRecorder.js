import { useCallback, useRef, useState } from 'react';
import { TRANSCRIPTION_SOURCE_TYPES as SOURCE_TYPES } from './useTranscriptionSession';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;
const DEFAULT_MIME = 'audio/webm;codecs=opus';

const buildRecorderOptions = (mimeType) => (mimeType ? { mimeType } : {});
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

export function useRecorder({
    chunkTimeslice,
    platform,
    preferredMimeType,
    sessionApi
}) {
    const [isSelectingSource, setIsSelectingSource] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [isMicReady, setIsMicReady] = useState(false);
    const [isMicActive, setIsMicActive] = useState(false);
    const [isMicPending, setIsMicPending] = useState(false);
    const [micError, setMicError] = useState('');
    const [micPendingAction, setMicPendingAction] = useState(null);

    const mediaRecorderRef = useRef(null);
    const captureStreamRef = useRef(null);
    const recordingMimeTypeRef = useRef(preferredMimeType || DEFAULT_MIME);
    const chunkSequenceRef = useRef(0);
    const stopSignalRef = useRef(0);
    const micStreamRef = useRef(null);
    const micRecorderRef = useRef(null);
    const micMimeTypeRef = useRef(preferredMimeType || DEFAULT_MIME);
    const micChunkSequenceRef = useRef(0);

    const handleChunk = useCallback(async (event) => {
        if (!event?.data?.size) {
            return;
        }
        const sessionId = sessionApi.getSessionId(SOURCE_TYPES.SYSTEM);
        if (!sessionId) {
            return;
        }
        try {
            const sequence = chunkSequenceRef.current;
            chunkSequenceRef.current += 1;
            const arrayBuffer = await event.data.arrayBuffer();
            const captureTimestamp = Date.now();
            electronAPI?.transcription?.sendChunk?.({
                sessionId,
                sequence,
                mimeType: recordingMimeTypeRef.current,
                data: arrayBuffer,
                timestamp: captureTimestamp,
                captureTimestamp,
                sourceType: SOURCE_TYPES.SYSTEM
            });
        } catch (error) {
            console.error('Failed to dispatch audio chunk', error);
        }
    }, [sessionApi]);

    const handleMicChunk = useCallback(async (event) => {
        if (!event?.data?.size) {
            return;
        }
        const sessionId = sessionApi.getSessionId(SOURCE_TYPES.MIC);
        if (!sessionId) {
            return;
        }
        try {
            const sequence = micChunkSequenceRef.current;
            micChunkSequenceRef.current += 1;
            const arrayBuffer = await event.data.arrayBuffer();
            const captureTimestamp = Date.now();
            electronAPI?.transcription?.sendChunk?.({
                sessionId,
                sequence,
                mimeType: micMimeTypeRef.current,
                data: arrayBuffer,
                timestamp: captureTimestamp,
                captureTimestamp,
                sourceType: SOURCE_TYPES.MIC
            });
        } catch (error) {
            console.error('Failed to dispatch microphone audio chunk', error);
        }
    }, [sessionApi]);

    const initializeMicStream = useCallback(async () => {
        const existingStream = micStreamRef.current;
        if (existingStream) {
            const hasLiveTrack = existingStream.getTracks().some((track) => track.readyState === 'live');
            if (hasLiveTrack) {
                setIsMicReady(true);
                return existingStream;
            }
            existingStream.getTracks().forEach((track) => track.stop());
            micStreamRef.current = null;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            micStreamRef.current = stream;
            setIsMicReady(true);
            setMicError('');
            return stream;
        } catch (error) {
            console.error('Failed to initialize microphone stream', error);
            setIsMicReady(false);
            setMicError(error?.message || 'Microphone unavailable');
            micStreamRef.current = null;
            return null;
        }
    }, []);

    const stopMicRecorder = useCallback(async ({ keepStream = true, stopSession = false } = {}) => {
        const recorder = micRecorderRef.current;
        if (recorder) {
            let resolveStop;
            const stopPromise = new Promise((resolve) => {
                resolveStop = resolve;
            });
            const handleStop = () => {
                recorder.removeEventListener('stop', handleStop);
                recorder.removeEventListener('dataavailable', handleMicChunk);
                if (resolveStop) {
                    resolveStop();
                }
            };
            recorder.addEventListener('stop', handleStop, { once: true });
            try {
                if (recorder.state !== 'inactive') {
                    recorder.stop();
                } else {
                    recorder.removeEventListener('dataavailable', handleMicChunk);
                    handleStop();
                }
            } catch (error) {
                console.warn('Mic recorder stop failed', error);
                recorder.removeEventListener('dataavailable', handleMicChunk);
                handleStop();
            }
            try {
                await stopPromise;
            } catch (_error) {
                // ignore
            }
        }
        micRecorderRef.current = null;
        micChunkSequenceRef.current = 0;
        micMimeTypeRef.current = preferredMimeType || DEFAULT_MIME;
        setIsMicActive(false);
        if (!keepStream && micStreamRef.current) {
            micStreamRef.current.getTracks().forEach((track) => track.stop());
            micStreamRef.current = null;
            setIsMicReady(false);
        }
        if (stopSession) {
            const currentMicSession = sessionApi.getSessionId?.(SOURCE_TYPES.MIC);
            if (currentMicSession) {
                try {
                    await sessionApi.stopSourceSession({ sourceType: SOURCE_TYPES.MIC });
                } catch (error) {
                    console.error('Failed to stop mic transcription session', error);
                }
            }
        }
    }, [handleMicChunk, preferredMimeType, sessionApi]);

    const startMicProcessing = useCallback(async () => {
        if (isMicPending || isMicActive) {
            return { ok: false, reason: 'busy' };
        }
        setIsMicPending(true);
        setMicPendingAction('starting');
        setMicError('');
        try {
            const stream = await initializeMicStream();
            if (!stream) {
                return { ok: false, reason: 'unavailable' };
            }

            if (!sessionApi.getSessionId(SOURCE_TYPES.MIC)) {
                const startResult = await sessionApi.startSourceSession({
                    sourceName: 'Microphone',
                    platform,
                    sourceType: SOURCE_TYPES.MIC
                });
                if (startResult?.cancelled) {
                    return { ok: false, reason: 'cancelled' };
                }
            }

            const recorderOptions = buildRecorderOptions(preferredMimeType);
            let recorder;
            try {
                recorder = new MediaRecorder(stream, recorderOptions);
            } catch (error) {
                console.warn('Preferred mic mime type failed, falling back to default', recorderOptions, error);
                recorder = new MediaRecorder(stream);
            }
            micRecorderRef.current = recorder;
            micMimeTypeRef.current = recorder?.mimeType || preferredMimeType || DEFAULT_MIME;
            recorder.addEventListener('dataavailable', handleMicChunk);
            recorder.addEventListener('error', async (event) => {
                console.error('Microphone recorder error', event.error);
                sessionApi.setStatus?.(`Mic recorder error: ${event.error?.message || event.error}`);
                setMicError(event.error?.message || 'Mic recorder error');
                await stopMicRecorder({ keepStream: true, stopSession: true });
                setIsMicPending(false);
                setMicPendingAction(null);
            });
            recorder.addEventListener('stop', () => {
                micRecorderRef.current = null;
            });
            micChunkSequenceRef.current = 0;
            recorder.start(chunkTimeslice);
            setIsMicActive(true);
            const systemStreaming = sessionApi.isSourceStreaming?.(SOURCE_TYPES.SYSTEM);
            sessionApi.setStatus?.(systemStreaming ? 'Capturing system + mic audio…' : 'Capturing microphone audio…');
            return { ok: true };
        } catch (error) {
            console.error('Failed to enable microphone capture', error);
            setMicError(error?.message || 'Microphone unavailable');
            const activeMicSession = sessionApi.getSessionId(SOURCE_TYPES.MIC);
            if (activeMicSession) {
                try {
                    await sessionApi.stopSourceSession({ sourceType: SOURCE_TYPES.MIC });
                } catch (_err) {
                    // ignore
                }
            }
            return { ok: false, error };
        } finally {
            setIsMicPending(false);
            setMicPendingAction(null);
        }
    }, [
        chunkTimeslice,
        handleMicChunk,
        initializeMicStream,
        isMicActive,
        isMicPending,
        platform,
        preferredMimeType,
        sessionApi,
        stopMicRecorder
    ]);

    const stopMicProcessing = useCallback(async () => {
        if (isMicPending) {
            return { ok: false, reason: 'busy' };
        }
        const hasSession = Boolean(sessionApi.getSessionId(SOURCE_TYPES.MIC));
        if (!isMicActive && !hasSession) {
            return { ok: true };
        }
        setIsMicPending(true);
        setMicPendingAction('stopping');
        try {
            await stopMicRecorder({ keepStream: true, stopSession: true });
            const systemStreaming = sessionApi.isSourceStreaming?.(SOURCE_TYPES.SYSTEM);
            sessionApi.setStatus?.(systemStreaming ? 'Capturing system audio…' : 'Idle');
            setMicError('');
            return { ok: true };
        } catch (error) {
            console.error('Failed to stop microphone capture', error);
            setMicError(error?.message || 'Failed to stop microphone');
            return { ok: false, error };
        } finally {
            setIsMicPending(false);
            setMicPendingAction(null);
        }
    }, [isMicActive, isMicPending, sessionApi, stopMicRecorder]);

    const toggleMicProcessing = useCallback(async () => {
        if (!isRecording) {
            return { ok: false, reason: 'system-inactive' };
        }
        if (isMicPending) {
            return { ok: false, reason: 'busy' };
        }
        if (isMicActive) {
            return stopMicProcessing();
        }
        return startMicProcessing();
    }, [isMicActive, isMicPending, isRecording, startMicProcessing, stopMicProcessing]);

    const stopCapture = useCallback(async () => {
        stopSignalRef.current += 1;
        setIsMicPending(false);
        setMicPendingAction(null);
        await stopMicRecorder({ keepStream: false, stopSession: false });
        setIsMicActive(false);
        setIsMicReady(false);
        setMicError('');
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
        micChunkSequenceRef.current = 0;
        micMimeTypeRef.current = preferredMimeType || DEFAULT_MIME;
        setIsSelectingSource(false);
        setIsRecording(false);
        await sessionApi.teardownSession();
    }, [preferredMimeType, sessionApi, stopMicRecorder]);

    const startStreamingWithSource = useCallback(async (source, stopToken) => {
        const sourceId = source?.id;
        if (!sourceId) {
            sessionApi.setStatus('No valid source selected.');
            return { ok: false, reason: 'invalid-source' };
        }

        const token = typeof stopToken === 'number' ? stopToken : stopSignalRef.current;
        const isCancelled = () => stopSignalRef.current !== token;

        setIsSelectingSource(true);
        sessionApi.setStatus('Preparing capture stream…');

        const videoConstraints = buildVideoConstraints(sourceId);
        const audioConstraints = buildAudioConstraints(sourceId, platform);

        let stream;
        let audioStream;
        try {
            if (isCancelled()) {
                return { ok: false, reason: 'cancelled' };
            }

            stream = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints,
                video: videoConstraints
            });

            if (isCancelled()) {
                stream.getTracks().forEach((track) => track.stop());
                captureStreamRef.current = null;
                return { ok: false, reason: 'cancelled' };
            }

            captureStreamRef.current = stream;
            const audioTracks = stream.getAudioTracks();
            if (!audioTracks.length) {
                stream.getTracks().forEach((track) => track.stop());
                captureStreamRef.current = null;
                sessionApi.setStatus('No system audio track detected.');
                return { ok: false, reason: 'no-audio-track' };
            }

            audioStream = new MediaStream(audioTracks);

            await initializeMicStream();
            if (isCancelled()) {
                stream.getTracks().forEach((track) => track.stop());
                captureStreamRef.current = null;
                return { ok: false, reason: 'cancelled' };
            }

            const startResult = await sessionApi.startTranscriptionSession({
                sourceName: source.name || source.id,
                platform,
                sourceType: SOURCE_TYPES.SYSTEM
            });

            if (!startResult?.sessionId) {
                sessionApi.setStatus('Transcription unavailable: session missing identifier.');
                await stopCapture();
                return { ok: false, reason: 'session-start-failed' };
            }

            if (startResult.cancelled || isCancelled()) {
                stream.getTracks().forEach((track) => track.stop());
                captureStreamRef.current = null;
                return { ok: false, reason: 'cancelled' };
            }

            sessionApi.attachTranscriptionEvents();

            const recorderOptions = buildRecorderOptions(preferredMimeType);
            try {
                mediaRecorderRef.current = new MediaRecorder(audioStream, recorderOptions);
            } catch (error) {
                console.warn('Preferred mime type failed, falling back to default', recorderOptions, error);
                if (isCancelled()) {
                    stream.getTracks().forEach((track) => track.stop());
                    captureStreamRef.current = null;
                    return { ok: false, reason: 'cancelled' };
                }
                mediaRecorderRef.current = new MediaRecorder(audioStream);
            }

            const recorder = mediaRecorderRef.current;
            recordingMimeTypeRef.current = recorder?.mimeType || preferredMimeType || DEFAULT_MIME;
            recorder.addEventListener('dataavailable', handleChunk);
            recorder.addEventListener('error', async (event) => {
                console.error('MediaRecorder error', event.error);
                sessionApi.setStatus(`Recorder error: ${event.error?.message || event.error}`);
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

            if (isCancelled()) {
                try {
                    recorder.stop();
                } catch (_error) {
                    // ignore inability to stop an already-stopped recorder
                }
                return { ok: false, reason: 'cancelled' };
            }

            sessionApi.clearTranscript();
            sessionApi.setStatus('Capturing system audio…');
            setIsRecording(true);
            return { ok: true };
        } catch (error) {
            console.error('[AUDIO DEBUG] Failed to obtain capture stream', error);
            console.error('[AUDIO DEBUG] Error details:', {
                message: error?.message,
                name: error?.name,
                code: error?.code,
                stack: error?.stack
            });
            sessionApi.setStatus(`Failed to capture system audio: ${error?.message || error}`);
            await stopCapture();
            return { ok: false, error, reason: 'error' };
        } finally {
            setIsSelectingSource(false);
        }
    }, [chunkTimeslice, handleChunk, initializeMicStream, platform, preferredMimeType, sessionApi, stopCapture]);

    const startRecording = useCallback(async () => {
        if (!electronAPI?.getDesktopSources) {
            sessionApi.setStatus('Desktop capture API unavailable in preload.');
            return;
        }
        const stopToken = stopSignalRef.current;
        setIsSelectingSource(true);
        setIsMicReady(false);
        setIsMicPending(false);
        setMicPendingAction(null);
        setMicError('');
        sessionApi.setStatus('Requesting capture sources…');
        try {
            const sources = await electronAPI.getDesktopSources({ types: ['screen', 'window'] });
            if (!sources?.length) {
                setIsSelectingSource(false);
                sessionApi.setStatus('No sources returned.');
                return;
            }
            const result = await startStreamingWithSource(sources[0], stopToken);
            if (!result?.ok && result?.reason === 'cancelled') {
                sessionApi.setStatus('Idle');
            }
        } catch (error) {
            console.error('Failed to list sources', error);
            setIsSelectingSource(false);
            sessionApi.setStatus(`Failed to list sources: ${error?.message || 'Unknown error'}`);
        }
    }, [sessionApi, startStreamingWithSource]);

    const stopRecording = useCallback(async () => {
        sessionApi.setStatus('Stopping capture…');
        await stopCapture();
        sessionApi.setStatus('Idle');
    }, [sessionApi, stopCapture]);

    return {
        isSelectingSource,
        isRecording,
        startRecording,
        stopRecording,
        startMic: startMicProcessing,
        stopMic: stopMicProcessing,
        toggleMic: toggleMicProcessing,
        mic: {
            isReady: isMicReady,
            isActive: isMicActive,
            isPending: isMicPending,
            pendingAction: micPendingAction,
            error: micError
        }
    };
}
