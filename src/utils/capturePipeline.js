export const DEFAULT_MIME = 'audio/webm;codecs=opus';

export const stopTracks = (stream) => {
    stream?.getTracks?.().forEach((track) => {
        try {
            track.stop();
        } catch (_err) {
            // ignore track stop issues
        }
    });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const buildDesktopConstraints = (sourceId) => ({
    audio: {
        mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
        }
    },
    video: {
        mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
        }
    }
});

const selectDesktopSource = async ({ electronAPI, types = ['screen', 'window'] }) => {
    if (!electronAPI?.getDesktopSources) {
        throw new Error('Desktop capture helpers are unavailable.');
    }
    const sources = await electronAPI.getDesktopSources({ types, fetchWindowIcons: false, thumbnailSize: { width: 16, height: 16 } });
    const source = Array.isArray(sources) && sources.length ? sources[0] : null;
    if (!source?.id) {
        throw new Error('No desktop source available.');
    }
    return source;
};

export const openDesktopCapture = async ({ electronAPI, source, types = ['screen', 'window'] }) => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Screen capture APIs are unavailable in this environment.');
    }
    const targetSource = source || await selectDesktopSource({ electronAPI, types });
    const constraints = buildDesktopConstraints(targetSource.id);
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
        stopTracks(stream);
        throw new Error('No system audio track detected.');
    }

    // Free GPU by stopping video tracks; retain audio.
    stream.getVideoTracks().forEach((track) => track.stop());

    const audioStream = new MediaStream([audioTracks[0]]);
    const cleanup = () => {
        stopTracks(stream);
        stopTracks(audioStream);
    };

    return { stream, audioStream, source: targetSource, cleanup };
};

export const runCaptureProbe = async ({ electronAPI, preferredMimeType, durationMs = 800, timeslice = 200, types = ['screen', 'window'] } = {}) => {
    const capture = await openDesktopCapture({ electronAPI, types });
    const { audioStream, cleanup } = capture;
    let recorder;
    try {
        const options = preferredMimeType ? { mimeType: preferredMimeType } : undefined;
        try {
            recorder = new MediaRecorder(audioStream, options);
        } catch (_err) {
            recorder = new MediaRecorder(audioStream);
        }

        let hadData = false;
        const dataPromise = new Promise((resolve, reject) => {
            recorder.addEventListener('dataavailable', (event) => {
                if (event?.data?.size) {
                    hadData = true;
                }
            });
            recorder.addEventListener('stop', () => resolve(hadData));
            recorder.addEventListener('error', (event) => reject(event?.error || event));
        });

        recorder.start(timeslice);
        await sleep(durationMs);
        try {
            recorder.stop();
        } catch (_error) {
            // ignore inability to stop if already stopped
        }

        const ok = await dataPromise;
        cleanup();
        if (!ok) {
            throw new Error('No audio data recorded during probe.');
        }
        return true;
    } catch (error) {
        cleanup();
        throw error;
    }
};

export default {
    DEFAULT_MIME,
    openDesktopCapture,
    runCaptureProbe,
    stopTracks,
    buildDesktopConstraints
};
