import { useCallback, useMemo, useState } from 'react';
import { runCaptureProbe } from '../utils/capturePipeline.js';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;

const TEST_STATES = {
    IDLE: 'idle',
    RUNNING: 'running',
    SUCCESS: 'success',
    FAILED: 'failed'
};

const formatTestLabel = (state) => {
    switch (state) {
    case TEST_STATES.RUNNING:
        return 'Testing…';
    case TEST_STATES.SUCCESS:
        return 'Working';
    case TEST_STATES.FAILED:
        return 'Needs retry';
    default:
        return 'Not tested';
    }
};

const stopTracks = (stream) => {
    stream?.getTracks?.().forEach((track) => {
        try {
            track.stop();
        } catch (_error) {
            // ignore track stop issues
        }
    });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runMicrophoneTest = async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone APIs are unavailable in this environment.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const hasLiveTrack = stream.getAudioTracks().some((track) => track.readyState === 'live');
    stopTracks(stream);
    if (!hasLiveTrack) {
        throw new Error('No live microphone track detected.');
    }
    return true;
};

const runScreenAudioTest = async () => runCaptureProbe({ electronAPI });

export default function PermissionWindow() {
    const [micStatus, setMicStatus] = useState(TEST_STATES.IDLE);
    const [screenAudioStatus, setScreenAudioStatus] = useState(TEST_STATES.IDLE);

    const isTesting = micStatus === TEST_STATES.RUNNING || screenAudioStatus === TEST_STATES.RUNNING;
    const canContinue = micStatus === TEST_STATES.SUCCESS && screenAudioStatus === TEST_STATES.SUCCESS;

    const handleMicTest = useCallback(async () => {
        setMicStatus(TEST_STATES.RUNNING);
        try {
            await runMicrophoneTest();
            setMicStatus(TEST_STATES.SUCCESS);
        } catch (error) {
            console.warn('Microphone test failed', error);
            setMicStatus(TEST_STATES.FAILED);
        }
    }, []);

    const handleScreenAudioTest = useCallback(async () => {
        setScreenAudioStatus(TEST_STATES.RUNNING);
        try {
            await runScreenAudioTest();
            setScreenAudioStatus(TEST_STATES.SUCCESS);
        } catch (error) {
            console.warn('Screen + audio test failed', error);
            setScreenAudioStatus(TEST_STATES.FAILED);
        }
    }, []);

    const handleContinue = useCallback(async () => {
        try {
            await electronAPI?.permissions?.acknowledge?.();
        } catch (_error) {
            // ignore acknowledgement failures
        }
        try {
            await electronAPI?.permissions?.close?.();
        } catch (_error) {
            // ignore close failures
        }
        if (typeof window !== 'undefined' && window.close) {
            window.close();
        }
    }, []);

    const testCards = useMemo(() => ([
        {
            key: 'microphone',
            title: 'Test microphone',
            rationale: 'We ask macOS for mic access and capture a quick sample to confirm your voice input works for transcription.',
            status: micStatus,
            onTest: handleMicTest,
            cta: micStatus === TEST_STATES.RUNNING ? 'Testing…' : 'Test mic'
        },
        {
            key: 'screen-audio',
            title: 'Test screen + system audio',
            rationale: 'Uses the same start button flow as recording: selects a desktop source, opens screen permission, and captures a short audio sample.',
            status: screenAudioStatus,
            onTest: handleScreenAudioTest,
            cta: screenAudioStatus === TEST_STATES.RUNNING ? 'Testing…' : 'Test screen + audio'
        }
    ]), [handleMicTest, handleScreenAudioTest, micStatus, screenAudioStatus]);

    return (
        <div className="permissions-window" role="presentation">
            <header className="permissions-header">
                <p className="permissions-kicker">macOS capture check</p>
                <h1>Test your setup before you go live</h1>
                <p className="permissions-intro">
                    We run two quick tests so macOS can grant access and we can confirm capture works. Nothing is recorded or kept. This just ensures your mic and screen + system audio are ready for the assistant.
                </p>
            </header>

            <div className="permissions-body">
                {testCards.map(({ key, title, rationale, status: entryStatus, onTest, cta }) => (
                    <article key={key} className="permissions-status-card">
                        <div className="permissions-card-header">
                            <h2>{title}</h2>
                            <span className={`permissions-badge state-${entryStatus}`}>
                                {formatTestLabel(entryStatus)}
                            </span>
                        </div>
                        <p className="permissions-rationale">{rationale}</p>
                        <div className="permissions-actions-row">
                            <button
                                type="button"
                                className="primary"
                                onClick={onTest}
                                disabled={entryStatus === TEST_STATES.RUNNING || isTesting}
                                aria-label={`${title} permission test`}
                            >
                                {cta}
                            </button>
                            <p className="permissions-hint">If macOS prompts, approve to continue.</p>
                        </div>
                    </article>
                ))}
            </div>

            {canContinue ? (
                <div className="permissions-alert success" role="status">All tests passed. You can continue to the app.</div>
            ) : (
                <div className="permissions-alert" role="status">Run both tests so we can verify mic and screen + audio access.</div>
            )}

            <footer className="permissions-actions">
                <button
                    type="button"
                    className="primary"
                    onClick={handleContinue}
                    disabled={!canContinue || isTesting}
                    aria-label={canContinue ? 'Continue to app' : 'Finish required tests before continuing'}
                >
                    {canContinue ? 'Continue' : 'Complete tests to continue'}
                </button>
            </footer>
        </div>
    );
}
