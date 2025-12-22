import { useCallback, useEffect, useState } from 'react';
import ChatBubble from './ChatBubble';
import { useTranscriptScroll } from '../hooks/useTranscriptScroll';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;
const SCROLL_STEP_PX = 280;

const SHORTCUT_SECTIONS = [
    {
        heading: 'Capture',
        hint: 'Streaming controls',
        shortcuts: [
            { label: 'Start / stop capture', combo: ['Ctrl', 'Shift', '/'] },
            { label: 'Toggle mic', combo: ['Ctrl', 'Shift', 'M'] }
        ]
    },
    {
        heading: 'Assistant',
        hint: 'Interact and respond',
        shortcuts: [
            { label: 'Capture to ask', combo: ['Ctrl', 'Shift', 'H'] },
            { label: 'Send request', combo: ['Ctrl', 'Enter'] }
        ]
    },
    {
        heading: 'Window',
        hint: 'Navigate quickly',
        shortcuts: [
            { label: 'Move control window', combo: ['Ctrl', '↑↓'] },
            { label: 'Scroll transcript', combo: ['Ctrl', 'Shift', '↑↓←→'] }
        ]
    }
];

export default function TranscriptWindow({ session }) {
    const {
        messages,
        isStreaming,
        attachTranscriptionEvents,
        attachAssistantEvents,
        clearTranscript,
        requestAssistantResponse,
        attachImageToDraft
    } = session;
    const { transcriptRef, scrollBy, resetScroll } = useTranscriptScroll({ messages });
    const [isGuideVisible, setGuideVisible] = useState(false);

    const handleClear = useCallback(() => {
        clearTranscript();
        resetScroll();
    }, [clearTranscript, resetScroll]);

    const toggleGuide = useCallback(() => {
        setGuideVisible((prev) => !prev);
    }, []);

    useEffect(() => {
        attachTranscriptionEvents();
        attachAssistantEvents();
    }, [attachAssistantEvents, attachTranscriptionEvents]);

    useEffect(() => {
        const api = electronAPI?.controlWindow;
        if (!api) {
            return () => {};
        }

        const unsubscribes = [];

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
    }, [attachImageToDraft, handleClear, requestAssistantResponse, scrollBy, toggleGuide]);

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

    return (
        <div className="transcript-shell">
            <section className="transcript-panel" aria-live="polite">
                <header className="transcript-heading">
                    <span className={`state-dot ${isStreaming ? 'state-dot-live' : ''}`} aria-hidden="true" />
                    <span className="heading-chip">{isStreaming ? 'Streaming' : 'Idle'}</span>
                </header>
                <div className="transcript-body" ref={transcriptRef}>
                    <div className="chat-container">
                        {messages.length === 0 ? (
                            <div className="chat-placeholder">Transcription will appear here once capture starts.</div>
                        ) : (
                            messages.map((msg) => (
                                <ChatBubble
                                    key={msg.id}
                                    side={msg.side || 'left'}
                                    text={msg.text}
                                    isFinal={msg.isFinal}
                                    sourceType={msg.sourceType}
                                    attachments={msg.attachments}
                                />
                            ))
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
                                {SHORTCUT_SECTIONS.map((section) => (
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
                            <span className="guide-hint-label">Press</span>
                            <span className="guide-shortcut-keys guide-hint-keys">
                                <kbd>Ctrl</kbd>
                                <kbd>H</kbd>
                            </span>
                            <span className="guide-hint-label">to show shortcuts</span>
                        </div>
                    )}
                </footer>
            </section>
        </div>
    );
}
