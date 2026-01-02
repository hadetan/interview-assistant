import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatBubble from './ChatBubble';
import { useTranscriptScroll } from '../hooks/useTranscriptScroll';
import { getAltModifierKey, getPrimaryModifierKey } from '../utils/osDetection';
import { clampOpacity, computeTranscriptOpacityVars } from '../utils/transcriptOpacity';
import './css/TranscriptWindow.css';
import { DEFAULT_TRANSCRIPT_OPACITY } from '../../utils/const';
import { useRecorder } from '../hooks/useRecorder';
import { getApiClient } from '../utils/apiClient.js';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;
const SCROLL_STEP_PX = 280;

export default function TranscriptWindow({ session, chunkTimeslice, preferredMimeType, platform }) {
    const {
        messages,
        attachTranscriptionEvents,
        attachAssistantEvents,
        clearTranscript,
        requestAssistantResponse,
        attachImageToDraft,
        startTranscriptionSession,
        teardownSession,
        getSessionId,
        startSourceSession,
        stopSourceSession,
        isSourceStreaming
    } = session;

    const sessionApi = useMemo(() => ({
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
        startSourceSession,
        startTranscriptionSession,
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

    const { transcriptRef, scrollBy, resetScroll } = useTranscriptScroll({ messages });
    const [isGuideVisible, setGuideVisible] = useState(false);
    const [transcriptOpacity, setTranscriptOpacity] = useState(DEFAULT_TRANSCRIPT_OPACITY);
    const primaryModifierKey = getPrimaryModifierKey();
    const altModifierKey = getAltModifierKey();
    const opacityStyles = useMemo(() => computeTranscriptOpacityVars(transcriptOpacity), [transcriptOpacity]);

    const streamingStateRef = useRef(false);
    const selectingSourceRef = useRef(false);

    useEffect(() => {
        streamingStateRef.current = isRecording;
    }, [isRecording]);

    useEffect(() => {
        selectingSourceRef.current = isSelectingSource;
    }, [isSelectingSource]);

    const isMicButtonDisabled = useMemo(() => {
        if (!isRecording) {
            return true;
        }
        return mic.isPending;
    }, [isRecording, mic]);

    useEffect(() => {
        if (mic.error) {
            console.error(mic.error);
        }
    }, [mic.error]);

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
        if (typeof window === 'undefined') {
            return () => { };
        }
        const handleBeforeUnload = () => {
            stopRecording().catch(() => { });
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            stopRecording().catch(() => { });
        };
    }, [stopRecording]);

    const shortcutSections = useMemo(() => ([
        {
            heading: 'Capture',
            hint: 'Streaming controls',
            shortcuts: [
                { label: 'Start / stop capture', combo: [primaryModifierKey, 'Shift', '/'] },
                { label: 'Toggle mic', combo: [primaryModifierKey, 'Shift', 'M'] }
            ]
        },
        {
            heading: 'Assistant',
            hint: 'Interact and respond',
            shortcuts: [
                { label: 'Capture to ask', combo: [primaryModifierKey, 'Shift', 'H'] },
                { label: 'Ask AI', combo: [primaryModifierKey, 'Enter'] }
            ]
        },
        {
            heading: 'Window',
            hint: 'Navigate quickly',
            shortcuts: [
                { label: 'Move transcript window', combo: [primaryModifierKey, 'Arrow ←↑↓→'] },
                { label: 'Scroll transcript', combo: [primaryModifierKey, 'Shift', 'Arrow ↑↓'] },
                { label: 'Hide/unhide app', combo: [primaryModifierKey, 'Shift', 'B'] }
            ]
        }
    ]), [primaryModifierKey]);
    const quitShortcutCombo = useMemo(() => ([altModifierKey || 'Alt', 'Shift', 'Q']), [altModifierKey]);
    const clearTranscriptCombo = useMemo(() => ([primaryModifierKey, 'Shift', 'G']), [primaryModifierKey]);

    const handleClear = useCallback(() => {
        clearTranscript();
        resetScroll();
    }, [clearTranscript, resetScroll]);

    const toggleGuide = useCallback(() => {
        setGuideVisible((prev) => !prev);
    }, []);

    useEffect(() => {
        let cancelled = false;
        if (!electronAPI?.settings?.getGeneral) {
            return () => {
                cancelled = true;
            };
        }

        const loadGeneralSettings = async () => {
            try {
                const response = await electronAPI.settings.getGeneral();
                const nextOpacity = response?.general?.transcriptOpacity;
                if (!cancelled && nextOpacity !== undefined) {
                    setTranscriptOpacity(clampOpacity(nextOpacity));
                }
            } catch (error) {
                console.warn('[TranscriptWindow] Failed to load general settings', error);
            }
        };

        loadGeneralSettings();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (typeof electronAPI?.settings?.onGeneralUpdated !== 'function') {
            return () => { };
        }
        const unsubscribe = electronAPI.settings.onGeneralUpdated((payload) => {
            const nextOpacity = payload?.general?.transcriptOpacity;
            if (nextOpacity !== undefined) {
                setTranscriptOpacity(clampOpacity(nextOpacity));
            }
        });
        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        };
    }, []);

    useEffect(() => {
        attachTranscriptionEvents();
        attachAssistantEvents();
    }, [attachAssistantEvents, attachTranscriptionEvents]);

    useEffect(() => {
        const api = electronAPI?.controlWindow;
        if (!api) {
            return () => { };
        }

        const unsubscribes = [];

        if (typeof api.onToggleCapture === 'function') {
            unsubscribes.push(api.onToggleCapture(async () => {
                try {
                    if (streamingStateRef.current || selectingSourceRef.current) {
                        await stopRecording();
                    } else {
                        await startRecording();
                    }
                } catch (error) {
                    console.error('Failed to toggle capture via shortcut', error);
                }
            }));
        }
        if (typeof api.onToggleMic === 'function') {
            unsubscribes.push(api.onToggleMic(() => {
                handleMicToggle();
            }));
        }
        if (typeof api.onToggleGuide === 'function') {
            unsubscribes.push(api.onToggleGuide(() => {
                toggleGuide();
            }));
        }
        if (typeof api.onScrollUp === 'function') {
            unsubscribes.push(api.onScrollUp(() => {
                scrollBy(-SCROLL_STEP_PX);
            }));
        }
        if (typeof api.onScrollDown === 'function') {
            unsubscribes.push(api.onScrollDown(() => {
                scrollBy(SCROLL_STEP_PX);
            }));
        }
        if (typeof api.onClearTranscripts === 'function') {
            unsubscribes.push(api.onClearTranscripts(() => {
                handleClear();
            }));
        }
        if (typeof api.onAssistantSend === 'function') {
            unsubscribes.push(api.onAssistantSend(() => {
                requestAssistantResponse();
            }));
        }
        if (typeof api.onAssistantAttach === 'function') {
            unsubscribes.push(api.onAssistantAttach((payload) => {
                attachImageToDraft(payload);
            }));
        }

        return () => {
            unsubscribes.forEach((fn) => {
                if (typeof fn === 'function') {
                    fn();
                }
            });
        };
    }, [
        attachImageToDraft,
        handleClear,
        handleMicToggle,
        requestAssistantResponse,
        scrollBy,
        startRecording,
        stopRecording,
        toggleGuide
    ]);

    useEffect(() => {
        if (electronAPI?.controlWindow?.onToggleGuide) {
            return undefined;
        }

        const handleKeydown = (event) => {
            const isToggleCombo = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && (event.key === 'h' || event.key === 'H');
            if (!isToggleCombo) {
                return;
            }
            event.preventDefault();
            toggleGuide();
        };

        window.addEventListener('keydown', handleKeydown);
        return () => {
            window.removeEventListener('keydown', handleKeydown);
        };
    }, [toggleGuide]);

    const guideClassName = `transcript-guide${isGuideVisible ? '' : ' transcript-guide-collapsed'}`;

    const captureActive = isRecording;
    const capturePending = isSelectingSource && !isRecording;
    const captureStateClass = captureActive ? 'state-dot-active' : (capturePending ? 'state-dot-pending' : '');

    const micActive = mic.isActive && !mic.isPending;
    const micPending = mic.isPending && mic.pendingAction === 'starting';
    const micStateClass = micActive ? 'state-dot-active' : (micPending ? 'state-dot-pending' : '');

    return (
        <div className="transcript-shell" style={opacityStyles}>
            <section className="transcript-panel" aria-live="polite">
                <header className="transcript-heading">
                    <div className="heading-status-container">
                        <div className="heading-status-item">
                            <span className={`state-dot ${captureStateClass}`} aria-hidden="true" />
                            <span className="heading-chip">
                                {
                                    !captureActive && !capturePending && "Capture system audio" ||
                                    capturePending && !captureActive && "Starting system capture" ||
                                    !capturePending && captureActive && "Streaming system audio"
                                }
                            </span>
                        </div>
                        <div className="heading-status-item" title={micActive ? 'Mic active' : (micPending ? 'Mic starting…' : 'Mic idle')}>
                            <span className={`state-dot ${micStateClass}`} aria-hidden="true" />
                            <span className="heading-chip">
                                {
                                    !micActive && !micPending && "Capture mic" ||
                                    micPending && !micActive && "Starting mic" ||
                                    !micPending && micActive && "Streaming mic"
                                }
                            </span>
                        </div>
                    </div>
                    <span className="heading-shortcut-hint">
                        <span className="guide-shortcut-keys">
                            {quitShortcutCombo.map((key) => (
                                <kbd key={key}>{key}</kbd>
                            ))}
                        </span>
                        <span className="heading-shortcut-label">to quit</span>
                    </span>
                </header>
                <div className="transcript-body" ref={transcriptRef}>
                    <div className="chat-container">
                        {messages.length === 0 ? (
                            <div className="chat-placeholder">Transcription will appear here once capture starts.</div>
                        ) : (
                            <>
                                {messages.map((msg) => (
                                    <ChatBubble
                                        key={msg.id}
                                        side={msg.side || 'left'}
                                        text={msg.text}
                                        isFinal={msg.isFinal}
                                        sourceType={msg.sourceType}
                                        attachments={msg.attachments}
                                        sent={msg.sent}
                                    />
                                ))}
                                <div className="chat-shortcut-hint" role="status" aria-live="polite">
                                    <span className="guide-shortcut-keys">
                                        {clearTranscriptCombo.map((key) => (
                                            <kbd key={key}>{key}</kbd>
                                        ))}
                                    </span>
                                    <span className="chat-shortcut-label">clear conversation</span>
                                </div>
                            </>
                        )}
                    </div>
                </div>
                <footer className={guideClassName} aria-label="Keyboard shortcuts">
                    {isGuideVisible ? (
                        <>
                            <div className="guide-header">
                                <div>
                                    <p className="guide-title">Control Guide</p>
                                </div>
                            </div>
                            <div className="guide-grid">
                                {shortcutSections.map((section) => (
                                    <section key={section.heading} className="guide-card">
                                        <header className="guide-card-head">
                                            <p className="guide-card-title">{section.heading}</p>
                                            <p className="guide-card-hint">{section.hint}</p>
                                        </header>
                                        <ul className="guide-card-list">
                                            {section.shortcuts.map((shortcut) => (
                                                <li key={shortcut.label} className="guide-shortcut">
                                                    <span className="guide-shortcut-label">{shortcut.label}</span>
                                                    <span className="guide-shortcut-keys">
                                                        {shortcut.combo.map((key) => (
                                                            <kbd key={key}>{key}</kbd>
                                                        ))}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                ))}
                            </div>
                        </>
                    ) : (
                        <div className="guide-hint" role="status" aria-live="polite">
                            {(!micActive && !captureActive) && (
                                <div className="hints">
                                    <span className="guide-shortcut-keys guide-hint-keys">
                                        <kbd>{primaryModifierKey}</kbd>
                                        <kbd>comma</kbd>
                                    </span>
                                    <span className="guide-hint-label">to open settings</span>
                                </div>
                            )}
                            <div className="hints">
                                <span className="guide-shortcut-keys guide-hint-keys">
                                    <kbd>{primaryModifierKey}</kbd>
                                    <kbd>H</kbd>
                                </span>
                                <span className="guide-hint-label">to show shortcuts</span>
                            </div>
                        </div>
                    )}
                </footer>
            </section>
        </div>
    );
}
