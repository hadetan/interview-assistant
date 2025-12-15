import { useCallback, useRef, useState } from 'react';

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

    const mediaRecorderRef = useRef(null);
    const captureStreamRef = useRef(null);
    const recordingMimeTypeRef = useRef(preferredMimeType || DEFAULT_MIME);
    const chunkSequenceRef = useRef(0);

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
        setIsRecording(false);
        await sessionApi.teardownSession();
    }, [preferredMimeType, sessionApi]);

    const handleChunk = useCallback(async (event) => {
        if (!event?.data?.size) {
            return;
        }
        const sessionId = sessionApi.getSessionId();
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
                captureTimestamp
            });
        } catch (error) {
            console.error('Failed to dispatch audio chunk', error);
        }
    }, [sessionApi]);

    const startStreamingWithSource = useCallback(async (source) => {
        const sourceId = source?.id;
        if (!sourceId) {
            sessionApi.setStatus('No valid source selected.');
            return;
        }
        setIsSelectingSource(true);
        sessionApi.setStatus('Preparing capture stream…');
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
            sessionApi.setStatus(`Failed to capture system audio: ${error?.message || error}`);
            setIsSelectingSource(false);
            return;
        }
        captureStreamRef.current = stream;
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) {
            sessionApi.setStatus('No system audio track detected.');
            setIsSelectingSource(false);
            return;
        }
        const audioStream = new MediaStream(audioTracks);
        try {
            await sessionApi.startTranscriptionSession({
                sourceName: source.name || source.id,
                platform
            });
        } catch (error) {
            console.error('Failed to start transcription session', error);
            sessionApi.setStatus(`Transcription unavailable: ${error?.message || 'unknown error'}`);
            setIsSelectingSource(false);
            await stopCapture();
            return;
        }
        sessionApi.attachTranscriptionEvents();
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
        sessionApi.clearTranscript();
        sessionApi.setStatus('Capturing system audio…');
        setIsRecording(true);
        setIsSelectingSource(false);
    }, [chunkTimeslice, handleChunk, platform, preferredMimeType, sessionApi, stopCapture]);

    const startRecording = useCallback(async () => {
        if (!electronAPI?.getDesktopSources) {
            sessionApi.setStatus('Desktop capture API unavailable in preload.');
            return;
        }
        setIsSelectingSource(true);
        sessionApi.setStatus('Requesting capture sources…');
        try {
            const sources = await electronAPI.getDesktopSources({ types: ['screen', 'window'] });
            setIsSelectingSource(false);
            if (!sources?.length) {
                sessionApi.setStatus('No sources returned.');
                return;
            }
            await startStreamingWithSource(sources[0]);
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
        stopRecording
    };
}
