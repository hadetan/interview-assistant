import { useCallback, useMemo, useState } from 'react';
import { runCaptureProbe } from '../utils/capturePipeline.js';
import MicIcon from '../assets/icons/mic.svg?react';
import ScreenIcon from '../assets/icons/screen.svg?react';

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

    const testsCompleted = useMemo(
        () => [micStatus, screenAudioStatus].filter((status) => status === TEST_STATES.SUCCESS).length,
        [micStatus, screenAudioStatus]
    );

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
            cta: micStatus === TEST_STATES.RUNNING ? 'Testing…' : 'Test mic',
            icon: <MicIcon className="permissions-card-icon" aria-hidden="true" focusable="false" />,
            hints: {
                [TEST_STATES.IDLE]: 'Click test and accept the macOS prompt so we can hear your microphone.',
                [TEST_STATES.RUNNING]: 'Capturing a short live sample to validate the audio stream.',
                [TEST_STATES.SUCCESS]: 'Microphone signal looks good—transcription will hear you clearly.',
                [TEST_STATES.FAILED]: 'Try again and double-check that macOS granted microphone access.'
            }
        },
        {
            key: 'screen-audio',
            title: 'Test screen + system audio',
            rationale: 'Uses the same start button flow as recording: selects a desktop source, opens screen permission, and captures a short audio sample.',
            status: screenAudioStatus,
            onTest: handleScreenAudioTest,
            cta: screenAudioStatus === TEST_STATES.RUNNING ? 'Testing…' : 'Test screen + audio',
            icon: <ScreenIcon className="permissions-card-icon" aria-hidden="true" focusable="false" />,
            hints: {
                [TEST_STATES.IDLE]: 'Choose your desktop source and allow screen + system audio capture.',
                [TEST_STATES.RUNNING]: 'Listening for output to be sure system audio routes correctly.',
                [TEST_STATES.SUCCESS]: 'Screen and system audio permissions are ready for the assistant.',
                [TEST_STATES.FAILED]: 'Restart the test and confirm the screen capture picker is accepted.'
            }
        }
    ]), [handleMicTest, handleScreenAudioTest, micStatus, screenAudioStatus]);

    const totalTests = testCards.length;
    const completionPercent = totalTests > 0 ? Math.round((testsCompleted / totalTests) * 100) : 0;

    return (
        <div className="permissions-window" role="presentation">
            <div className="permissions-layout">
                <header className="permissions-hero">
                    <div className="permissions-hero-copy">
                        <p className="permissions-kicker">macOS capture check</p>
                        <h1 id="permissions-title">Test your setup before you go live</h1>
                        <p className="permissions-intro">
                            Authorize capture once and stay in the flow. We run quick checks so macOS grants access and we confirm your mic and system audio are ready for the assistant.
                        </p>
                        <div
                            className="permissions-progress"
                            role="status"
                            aria-live="polite"
                            aria-label={`Progress ${testsCompleted} of ${totalTests} tests ready`}
                        >
                            <div className="permissions-progress-bar" aria-hidden="true">
                                <div style={{ width: `${completionPercent}%` }} />
                            </div>
                            <div className="permissions-progress-copy">
                                <strong>{testsCompleted}/{totalTests} ready</strong>
                                <span>{canContinue ? 'All set—continue below.' : 'Complete the quick checks to continue.'}</span>
                            </div>
                        </div>
                    </div>
                    <div className="permissions-hero-art" aria-hidden="true">
                        <span className="permissions-hero-ring" />
                        <span className="permissions-hero-orb" />
                    </div>
                </header>

                <div className="permissions-body" aria-describedby="permissions-title">
                    <section className="permissions-status-grid" aria-label="Capture readiness checks">
                        {testCards.map(({ key, title, rationale, status: entryStatus, onTest, cta, icon, hints }) => (
                            <article key={key} className={`permissions-status-card state-${entryStatus}`}>
                                <header className="permissions-card-header">
                                    <div className="permissions-card-title">
                                        <div className="permissions-icon-shell">{icon}</div>
                                        <div>
                                            <h2>{title}</h2>
                                            <span className="permissions-card-status">
                                                <span className={`status-pill status-${entryStatus}`}>
                                                    <span className="status-indicator" aria-hidden="true" />
                                                    {formatTestLabel(entryStatus)}
                                                </span>
                                            </span>
                                        </div>
                                    </div>
                                </header>
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
                                    <p className="permissions-hint">{hints?.[entryStatus] ?? 'If macOS prompts, approve to continue.'}</p>
                                </div>
                            </article>
                        ))}
                    </section>

                    <aside className="permissions-guidance" aria-live="polite">
                        <h3>Need to troubleshoot?</h3>
                        <p>
                            You can revisit permissions in System Settings &gt; Privacy & Security. For screen recording, confirm the app is checked under Screen Recording and Accessibility.
                        </p>
                    </aside>
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
        </div>
    );
}
