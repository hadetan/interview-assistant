import { useCallback, useEffect } from 'react';
import ChatBubble from './ChatBubble';
import { useTranscriptScroll } from '../hooks/useTranscriptScroll';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;
const SCROLL_STEP_PX = 140;

export default function TranscriptWindow({ session, chunkTimeslice }) {
    const {
        messages,
        latencyStatus,
        isStreaming,
        attachTranscriptionEvents,
        attachAssistantEvents,
        clearTranscript,
        requestAssistantResponse,
        attachImageToDraft,
        notification
    } = session;
    const { transcriptRef, scrollBy, resetScroll } = useTranscriptScroll({ messages });

    const handleClear = useCallback(() => {
        clearTranscript();
        resetScroll();
    }, [clearTranscript, resetScroll]);

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
    }, [attachImageToDraft, handleClear, requestAssistantResponse, scrollBy]);

    return (
        <div className="transcript-shell" >
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
                <footer className="transcript-meta">
                    <span>{latencyStatus || `Chunk cadence ${chunkTimeslice} ms`}</span>
                </footer>
            </section>
        </div>
    );
}
