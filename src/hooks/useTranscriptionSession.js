import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { initialTranscriptText, resolveTranscriptText, isTranscriptRollback } from '../utils/transcriptText.js';
import { buildAttachmentPreview, mergeAttachmentPreviews } from '../utils/attachmentPreview.js';
import { mergeAssistantText } from '../utils/assistantMessage.js';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;
const STALL_THRESHOLD_MS = 1500;
const STALL_WATCH_INTERVAL_MS = 1000;
const CONTINUATION_LINGER_MS = 2500;
const SOURCE_TYPES = {
    SYSTEM: 'system',
    MIC: 'mic'
};
export const TRANSCRIPTION_SOURCE_TYPES = SOURCE_TYPES;

const createClientSessionId = () => {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch (_error) {
        // ignore inability to use crypto.randomUUID
    }
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const createConversationId = () => {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch (_error) {
        // ignore inability to use crypto.randomUUID
    }
    return `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export function useTranscriptionSession({ isControlWindow }) {
    const [status, setStatus] = useState('Idle');
    const [messages, setMessages] = useState([]);
    const [latencyStatus, setLatencyStatus] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [notification, setNotification] = useState('');

    const sessionIdRef = useRef(null);
    const stopTranscriptionListenerRef = useRef(null);
    const sessionTrackersRef = useRef(new Map());
    const sourceSessionMapRef = useRef(new Map());
    const pendingSessionStartsRef = useRef(new Map());
    const latencyTimerRef = useRef(null);
    const lastLatencyTsRef = useRef(0);
    const latencyLabelRef = useRef('');
    const latencySuffixRef = useRef('');
    const latencySuffixReasonRef = useRef('');
    const assistantListenerRef = useRef(null);
    const assistantSessionIdRef = useRef(null);
    const assistantRequestInFlightRef = useRef(false);
    const conversationIdRef = useRef(null);
    const messagesRef = useRef([]);
    const imageDraftIdRef = useRef(null);
    const notificationTimerRef = useRef(null);

    const ensureSessionTracker = useCallback((sessionId, sourceTypeHint) => {
        if (!sessionId) {
            return null;
        }
        const map = sessionTrackersRef.current;
        let tracker = map.get(sessionId);
        if (!tracker) {
            tracker = {
                sessionId,
                sourceType: sourceTypeHint || SOURCE_TYPES.SYSTEM,
                pendingMessageId: null,
                continuationMessageId: null,
                lastMessageUpdateTs: 0,
                isStreaming: false,
                lastServerText: ''
            };
            map.set(sessionId, tracker);
        } else if (sourceTypeHint && tracker.sourceType !== sourceTypeHint) {
            tracker.sourceType = sourceTypeHint;
        }
        if (typeof tracker.lastServerText !== 'string') {
            tracker.lastServerText = '';
        }
        return tracker;
    }, []);

    const updateStreamingState = useCallback(() => {
        const trackers = Array.from(sessionTrackersRef.current.values());
        const anyStreaming = trackers.some((tracker) => tracker.isStreaming);
        setIsStreaming(anyStreaming);
    }, []);

    const resetTranscriptionListener = useCallback(() => {
        if (typeof stopTranscriptionListenerRef.current === 'function') {
            stopTranscriptionListenerRef.current();
        }
        stopTranscriptionListenerRef.current = null;
    }, []);

    const resetAssistantListener = useCallback(() => {
        if (typeof assistantListenerRef.current === 'function') {
            assistantListenerRef.current();
        }
        assistantListenerRef.current = null;
    }, []);

    const formatStalledLabel = useCallback((durationMs) => {
        const seconds = Math.max(1, Math.round(Math.max(0, durationMs) / 1000));
        return `(stalled ${seconds}s)`;
    }, []);

    const updateLatencyStatus = useCallback((overrideSuffix) => {
        const suffix = typeof overrideSuffix === 'string' ? overrideSuffix : latencySuffixRef.current;
        const base = latencyLabelRef.current;
        if (!base && !suffix) {
            setLatencyStatus('');
            return;
        }
        if (!base) {
            setLatencyStatus((suffix || '').trim());
            return;
        }
        const extra = suffix ? ` ${suffix}` : '';
        setLatencyStatus(`Latency ${base}${extra}`);
    }, []);

    const resetLatencyWatchdog = useCallback(() => {
        if (latencyTimerRef.current) {
            clearInterval(latencyTimerRef.current);
            latencyTimerRef.current = null;
        }
        lastLatencyTsRef.current = 0;
        latencyLabelRef.current = '';
        latencySuffixRef.current = '';
        latencySuffixReasonRef.current = '';
        setLatencyStatus('');
    }, []);

    const ensureLatencyWatchdog = useCallback(() => {
        if (latencyTimerRef.current) {
            return;
        }
        latencyTimerRef.current = window.setInterval(() => {
            if (!sessionIdRef.current || !latencyLabelRef.current || !lastLatencyTsRef.current) {
                return;
            }
            const stalledFor = Date.now() - lastLatencyTsRef.current;
            if (stalledFor >= STALL_THRESHOLD_MS && latencySuffixReasonRef.current !== 'heartbeat-silence') {
                latencySuffixRef.current = formatStalledLabel(stalledFor);
                latencySuffixReasonRef.current = 'stall';
                updateLatencyStatus();
            }
        }, STALL_WATCH_INTERVAL_MS);
    }, [formatStalledLabel, updateLatencyStatus]);

    const discardAssistantDraft = useCallback(({ discardAll = false, draftId } = {}) => {
        const requestDiscardAll = discardAll === true;
        const targetDraftId = requestDiscardAll ? null : (draftId || imageDraftIdRef.current);
        if (!requestDiscardAll && !targetDraftId) {
            return;
        }
        if (requestDiscardAll || targetDraftId === imageDraftIdRef.current) {
            imageDraftIdRef.current = null;
        }
        if (typeof electronAPI?.assistant?.discardDraft !== 'function') {
            return;
        }
        const payload = requestDiscardAll ? { discardAll: true } : { draftId: targetDraftId };
        electronAPI.assistant.discardDraft(payload).catch((error) => {
            console.warn('Failed to discard assistant draft', error);
        });
    }, []);

    const clearConversationHistory = useCallback(() => {
        const existingId = conversationIdRef.current;
        if (!existingId) {
            return;
        }
        conversationIdRef.current = null;
        if (typeof electronAPI?.assistant?.clearHistory === 'function') {
            electronAPI.assistant.clearHistory({ conversationId: existingId }).catch((error) => {
                console.warn('Failed to clear assistant conversation history', error);
            });
        }
    }, []);

    const ensureConversationId = useCallback(() => {
        if (conversationIdRef.current) {
            return conversationIdRef.current;
        }
        const id = createConversationId();
        conversationIdRef.current = id;
        return id;
    }, []);

    const clearTranscript = useCallback(() => {
        clearConversationHistory();
        sessionTrackersRef.current.forEach((tracker) => {
            if (!tracker) {
                return;
            }
            tracker.pendingMessageId = null;
            tracker.continuationMessageId = null;
            tracker.lastMessageUpdateTs = 0;
            tracker.lastServerText = '';
        });
        setMessages([]);
        messagesRef.current = [];
        assistantSessionIdRef.current = null;
        assistantRequestInFlightRef.current = false;
        imageDraftIdRef.current = null;
        setNotification('');
        discardAssistantDraft({ discardAll: true });
    }, [clearConversationHistory, discardAssistantDraft]);

    const teardownSession = useCallback(async () => {
        resetTranscriptionListener();
        pendingSessionStartsRef.current.forEach((entry) => {
            if (entry) {
                entry.cancelled = true;
            }
        });
        pendingSessionStartsRef.current.clear();
        const sessionIds = Array.from(sessionTrackersRef.current.keys());
        sessionIdRef.current = null;
        sourceSessionMapRef.current.clear();
        if (isControlWindow && sessionIds.length > 0 && electronAPI?.transcription?.stopSession) {
            const stops = sessionIds.map((id) => electronAPI.transcription.stopSession(id).catch(() => {}));
            await Promise.allSettled(stops);
        }
        sessionTrackersRef.current.clear();
        setMessages([]);
        setIsStreaming(false);
        resetLatencyWatchdog();
        discardAssistantDraft({ discardAll: true });
        clearConversationHistory();
    }, [clearConversationHistory, discardAssistantDraft, isControlWindow, resetLatencyWatchdog, resetTranscriptionListener]);

    const getSessionId = useCallback((sourceType = SOURCE_TYPES.SYSTEM) => {
        if (sourceType) {
            return sourceSessionMapRef.current.get(sourceType) || null;
        }
        return sessionIdRef.current;
    }, []);

    const isSourceStreaming = useCallback((sourceType) => {
        if (!sourceType) {
            return false;
        }
        const sessionId = sourceSessionMapRef.current.get(sourceType);
        if (!sessionId) {
            return false;
        }
        const tracker = sessionTrackersRef.current.get(sessionId);
        return Boolean(tracker?.isStreaming);
    }, []);

    const startTranscriptionSession = useCallback(async ({ sourceName, platform, sourceType = SOURCE_TYPES.SYSTEM }) => {
        if (typeof electronAPI?.transcription?.startSession !== 'function') {
            throw new Error('Transcription start API unavailable.');
        }

        const provisionalSessionId = createClientSessionId();
        const startToken = Symbol(sourceType || 'session');

        ensureSessionTracker(provisionalSessionId, sourceType);
        sourceSessionMapRef.current.set(sourceType, provisionalSessionId);
        if (sourceType === SOURCE_TYPES.SYSTEM) {
            sessionIdRef.current = provisionalSessionId;
        }

        pendingSessionStartsRef.current.set(sourceType, {
            sessionId: provisionalSessionId,
            token: startToken,
            cancelled: false
        });

        let response;
        try {
            response = await electronAPI.transcription.startSession({
                sessionId: provisionalSessionId,
                sourceName,
                platform,
                sourceType
            });
        } catch (error) {
            const pending = pendingSessionStartsRef.current.get(sourceType);
            if (pending?.token === startToken) {
                pendingSessionStartsRef.current.delete(sourceType);
            }
            if (sourceSessionMapRef.current.get(sourceType) === provisionalSessionId) {
                sourceSessionMapRef.current.delete(sourceType);
                if (sourceType === SOURCE_TYPES.SYSTEM && sessionIdRef.current === provisionalSessionId) {
                    sessionIdRef.current = null;
                }
            }
            sessionTrackersRef.current.delete(provisionalSessionId);
            throw error;
        }

        const receivedSessionId = response?.sessionId || provisionalSessionId;
        const pending = pendingSessionStartsRef.current.get(sourceType);
        const isStale = !pending || pending.token !== startToken;
        const wasCancelled = pending?.cancelled === true;

        if (!isStale) {
            pendingSessionStartsRef.current.delete(sourceType);
        }

        if (isStale || wasCancelled) {
            if (sourceSessionMapRef.current.get(sourceType) === provisionalSessionId) {
                sourceSessionMapRef.current.delete(sourceType);
                if (sourceType === SOURCE_TYPES.SYSTEM && sessionIdRef.current === provisionalSessionId) {
                    sessionIdRef.current = null;
                }
            }
            sessionTrackersRef.current.delete(provisionalSessionId);
            if (receivedSessionId && receivedSessionId !== provisionalSessionId) {
                sessionTrackersRef.current.delete(receivedSessionId);
            }
            if (typeof electronAPI?.transcription?.stopSession === 'function') {
                try {
                    await electronAPI.transcription.stopSession(receivedSessionId);
                } catch (_error) {
                    // ignore inability to stop a just-cancelled session
                }
            }
            return { sessionId: receivedSessionId, cancelled: true };
        }

        if (receivedSessionId && receivedSessionId !== provisionalSessionId) {
            const tracker = sessionTrackersRef.current.get(provisionalSessionId);
            if (tracker) {
                sessionTrackersRef.current.delete(provisionalSessionId);
                tracker.sessionId = receivedSessionId;
                sessionTrackersRef.current.set(receivedSessionId, tracker);
            }
            sourceSessionMapRef.current.set(sourceType, receivedSessionId);
            if (sourceType === SOURCE_TYPES.SYSTEM && sessionIdRef.current === provisionalSessionId) {
                sessionIdRef.current = receivedSessionId;
            }
        }

        return { sessionId: receivedSessionId, cancelled: false };
    }, [ensureSessionTracker]);

    const stopTranscriptionSession = useCallback(async ({ sourceType = SOURCE_TYPES.SYSTEM } = {}) => {
        const pending = pendingSessionStartsRef.current.get(sourceType);
        if (pending) {
            pending.cancelled = true;
        }

        const targetSessionId = sourceSessionMapRef.current.get(sourceType) || pending?.sessionId;
        if (!targetSessionId || typeof electronAPI?.transcription?.stopSession !== 'function') {
            if (pending) {
                pendingSessionStartsRef.current.delete(sourceType);
            }
            return;
        }

        if (sourceType === SOURCE_TYPES.SYSTEM && sessionIdRef.current === targetSessionId) {
            sessionIdRef.current = null;
        }

        sourceSessionMapRef.current.delete(sourceType);
        pendingSessionStartsRef.current.delete(sourceType);

        try {
            await electronAPI.transcription.stopSession(targetSessionId);
        } catch (_error) {
            // ignore inability to stop an already-closed session
        }

        if (sourceType === SOURCE_TYPES.SYSTEM) {
            resetLatencyWatchdog();
        }
    }, [resetLatencyWatchdog]);

    const applyTranscriptUpdateForSession = useCallback((tracker, payload) => {
        if (!tracker) {
            return;
        }

        const serverText = (() => {
            if (typeof payload.text === 'string') return payload.text;
            if (typeof payload.transcript === 'string') return payload.transcript;
            if (typeof payload.message === 'string') return payload.message;
            if (typeof payload.partial === 'string') return payload.partial;
            return '';
        })();
        const delta = (() => {
            if (typeof payload.delta === 'string') return payload.delta;
            if (typeof payload.chars === 'string') return payload.chars;
            if (typeof payload.partial === 'string') return payload.partial;
            return '';
        })();
        const isFinal = Boolean(payload.isFinal);
        const hasDelta = delta.length > 0;
        const hasServerText = serverText.length > 0;
        if (!hasDelta && !hasServerText) {
            return;
        }

        const now = Date.now();
        const lastUpdateTs = tracker.lastMessageUpdateTs || 0;
        const canContinue = lastUpdateTs > 0 && (now - lastUpdateTs) <= CONTINUATION_LINGER_MS;
        const textContext = { delta, serverText };
        const previousAbsolute = tracker.lastServerText || '';
        const candidateAbsolute = resolveTranscriptText(previousAbsolute, textContext);
        const rollbackDetected = isTranscriptRollback({
            previousText: previousAbsolute,
            nextText: candidateAbsolute,
            isFinal,
            hasServerText
        });
        const previousMessageId = tracker.pendingMessageId || tracker.continuationMessageId;
        const continuationId = canContinue && !rollbackDetected ? tracker.continuationMessageId : null;

        if (!canContinue || rollbackDetected) {
            tracker.continuationMessageId = null;
        }

        setMessages((prev) => {
            const next = [...prev];
            let forceNewMessage = rollbackDetected;
            let targetId = forceNewMessage ? null : (tracker.pendingMessageId || continuationId);

            if (!forceNewMessage && targetId) {
                const targetIndex = next.findIndex((msg) => msg.id === targetId);
                if (targetIndex !== -1) {
                    const current = next[targetIndex];
                    const updatedText = resolveTranscriptText(current.text, textContext);
                    const shrank = !isFinal && typeof current.text === 'string' && updatedText.length < current.text.length;
                    if (shrank) {
                        forceNewMessage = true;
                    } else {
                        next[targetIndex] = { ...current, text: updatedText, isFinal, sourceType: tracker.sourceType };
                        tracker.pendingMessageId = isFinal ? null : targetId;
                        tracker.continuationMessageId = isFinal ? null : targetId;
                        tracker.lastMessageUpdateTs = now;
                        tracker.lastServerText = isFinal ? '' : candidateAbsolute;
                        return next;
                    }
                } else {
                    targetId = null;
                }
            }

            if (forceNewMessage && previousMessageId) {
                const existingIndex = next.findIndex((msg) => msg.id === previousMessageId);
                if (existingIndex !== -1 && !next[existingIndex].isFinal) {
                    next[existingIndex] = { ...next[existingIndex], isFinal: true };
                }
                tracker.pendingMessageId = null;
                tracker.continuationMessageId = null;
                tracker.lastServerText = '';
                tracker.lastMessageUpdateTs = 0;
            }

            const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const initialText = candidateAbsolute || initialTranscriptText(textContext);
            if (!initialText) {
                return next;
            }

            tracker.pendingMessageId = isFinal ? null : id;
            tracker.continuationMessageId = isFinal ? null : id;
            tracker.lastMessageUpdateTs = now;
            tracker.lastServerText = isFinal ? '' : candidateAbsolute;

            next.push({ id, text: initialText, isFinal, ts: now, side: 'left', sent: false, sourceType: tracker.sourceType });
            return next;
        });
    }, []);

    const attachTranscriptionEvents = useCallback(() => {
        if (typeof electronAPI?.transcription?.onEvent !== 'function') {
            return;
        }
        resetTranscriptionListener();
        stopTranscriptionListenerRef.current = electronAPI.transcription.onEvent((payload = {}) => {
            const eventSessionId = payload.sessionId;
            if (!eventSessionId) {
                return;
            }
            if (isControlWindow && !sessionTrackersRef.current.has(eventSessionId)) {
                // Accept the event but backfill the tracker to avoid silently dropping updates
                ensureSessionTracker(eventSessionId, payload.sourceType);
            }

            const tracker = ensureSessionTracker(eventSessionId, payload.sourceType);
            if (!tracker) {
                return;
            }

            switch (payload.type) {
                case 'started':
                    tracker.isStreaming = true;
                    if (payload.sourceType && !sourceSessionMapRef.current.has(payload.sourceType)) {
                        sourceSessionMapRef.current.set(payload.sourceType, eventSessionId);
                    }
                    if (!isControlWindow && tracker.sourceType === SOURCE_TYPES.SYSTEM) {
                        sessionIdRef.current = eventSessionId;
                    }
                    if (tracker.sourceType === SOURCE_TYPES.SYSTEM) {
                        ensureLatencyWatchdog();
                        lastLatencyTsRef.current = Date.now();
                        latencyLabelRef.current = '';
                        latencySuffixRef.current = '';
                        setStatus('Streaming transcription active.');
                    }
                    updateStreamingState();
                    break;
                case 'update':
                    applyTranscriptUpdateForSession(tracker, payload);
                    if (tracker.sourceType === SOURCE_TYPES.SYSTEM) {
                        lastLatencyTsRef.current = Date.now();
                        latencyLabelRef.current = `WS ${payload.latencyMs ?? '-'}ms | E2E ${payload.pipelineMs ?? '-'}ms | CONV ${payload.conversionMs ?? '-'}ms`;
                        latencySuffixRef.current = '';
                        latencySuffixReasonRef.current = '';
                        ensureLatencyWatchdog();
                        updateLatencyStatus();
                    }
                    break;
                case 'warning':
                    if (tracker.sourceType === SOURCE_TYPES.SYSTEM) {
                        resetLatencyWatchdog();
                        latencySuffixRef.current = '';
                        latencySuffixReasonRef.current = '';
                        setStatus(`Transcription warning: ${payload.warning?.message || payload.warning?.code || payload.message || 'Unknown warning'}`);
                    }
                    break;
                case 'error':
                    if (tracker.sourceType === SOURCE_TYPES.SYSTEM) {
                        resetLatencyWatchdog();
                        latencySuffixRef.current = '';
                        latencySuffixReasonRef.current = '';
                        setStatus(`Transcription error: ${payload.error?.message || 'Unknown error'}`);
                    }
                    break;
                case 'stopped': {
                    tracker.pendingMessageId = null;
                    tracker.continuationMessageId = null;
                    tracker.lastMessageUpdateTs = 0;
                    tracker.isStreaming = false;
                    if (sourceSessionMapRef.current.get(tracker.sourceType) === eventSessionId) {
                        sourceSessionMapRef.current.delete(tracker.sourceType);
                    }
                    sessionTrackersRef.current.delete(eventSessionId);
                    if (tracker.sourceType === SOURCE_TYPES.SYSTEM) {
                        resetLatencyWatchdog();
                        latencySuffixRef.current = '';
                        latencySuffixReasonRef.current = '';
                        setStatus('Transcription session stopped.');
                        if (!isControlWindow) {
                            sessionIdRef.current = null;
                        }
                    }
                    updateStreamingState();
                    break;
                }
                case 'heartbeat':
                    if (tracker.sourceType === SOURCE_TYPES.SYSTEM) {
                        const state = payload.state || (payload.silent ? 'silence' : 'speech');
                        if (state === 'reconnecting') {
                            latencySuffixRef.current = '(reconnecting…)';
                            latencySuffixReasonRef.current = 'reconnecting';
                        } else if (state === 'reconnected') {
                            latencySuffixRef.current = '(reconnected)';
                            latencySuffixReasonRef.current = 'reconnected';
                        } else if (state === 'silence') {
                            const duration = Math.max(0, Number(payload.silenceDurationMs) || 0);
                            latencySuffixRef.current = formatStalledLabel(duration);
                            latencySuffixReasonRef.current = 'heartbeat-silence';
                        } else if (state === 'speech') {
                            if (latencySuffixReasonRef.current === 'heartbeat-silence') {
                                latencySuffixRef.current = '';
                                latencySuffixReasonRef.current = '';
                            }
                        } else if (latencySuffixReasonRef.current !== 'stall') {
                            latencySuffixRef.current = '';
                            latencySuffixReasonRef.current = '';
                        }
                        updateLatencyStatus();
                    }
                    break;
                default:
                    break;
            }
        });
    }, [
        applyTranscriptUpdateForSession,
        ensureLatencyWatchdog,
        ensureSessionTracker,
        formatStalledLabel,
        isControlWindow,
        resetLatencyWatchdog,
        resetTranscriptionListener,
        updateLatencyStatus,
        updateStreamingState
    ]);

    useEffect(() => () => {
        resetTranscriptionListener();
        resetLatencyWatchdog();
        resetAssistantListener();
        if (notificationTimerRef.current) {
            clearTimeout(notificationTimerRef.current);
            notificationTimerRef.current = null;
        }
        setNotification('');
    }, [resetAssistantListener, resetLatencyWatchdog, resetTranscriptionListener]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    const showNotification = useCallback((text) => {
        if (!text) {
            return;
        }
        setNotification(text);
        if (notificationTimerRef.current) {
            clearTimeout(notificationTimerRef.current);
        }
        notificationTimerRef.current = setTimeout(() => {
            setNotification('');
            notificationTimerRef.current = null;
        }, 2600);
    }, []);

    const appendAssistantNotice = useCallback((text) => {
        if (!text) {
            return;
        }
        showNotification(text);
        setMessages((prev) => ([
            ...prev,
            {
                id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                text,
                isFinal: true,
                ts: Date.now(),
                side: 'right'
            }
        ]));
    }, [showNotification]);

    const upsertImageBubble = useCallback(({ draftId, attachments }) => {
        if (!draftId || !attachments?.length) {
            return;
        }
        setMessages((prev) => {
            const next = [...prev];
            const existingIndex = next.findIndex((msg) => msg.side === 'right' && msg.draftId === draftId && msg.type === 'image');
            const normalizedAttachments = attachments.map((att, index) => {
                if (att?.dataUrl) {
                    return att;
                }
                return buildAttachmentPreview({
                    image: att,
                    fallbackId: `${draftId}-${Date.now()}-${index}`
                });
            });
            if (existingIndex !== -1) {
                const existing = next[existingIndex];
                const merged = mergeAttachmentPreviews(existing.attachments || [], normalizedAttachments);
                next[existingIndex] = { ...existing, attachments: merged, sent: false, isFinal: false };
                return next;
            }
            next.push({
                id: draftId,
                draftId,
                type: 'image',
                attachments: normalizedAttachments,
                text: '',
                isFinal: false,
                ts: Date.now(),
                side: 'right',
                sent: false
            });
            return next;
        });
    }, []);

    const updateAssistantMessage = useCallback((payload = {}) => {
        const { messageId } = payload;
        if (!messageId) {
            return;
        }
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        const serverText = typeof payload.text === 'string' ? payload.text : undefined;
        const isFinal = Boolean(payload.isFinal);
        setMessages((prev) => {
            let matched = false;
            const next = prev.map((msg) => {
                if (msg.id !== messageId) {
                    return msg;
                }
                matched = true;
                const { text: mergedText, didUpdate } = mergeAssistantText(msg.text, { delta, serverText });
                const needsUpdate = didUpdate || msg.isFinal !== isFinal;
                if (!needsUpdate) {
                    return msg;
                }
                return { ...msg, text: mergedText, isFinal };
            });
            if (!matched) {
                const { text: newText, didUpdate } = mergeAssistantText('', { delta, serverText });
                if (didUpdate) {
                    next.push({
                        id: messageId,
                        text: newText,
                        isFinal,
                        ts: Date.now(),
                        side: 'right'
                    });
                }
            }
            return next;
        });
    }, []);

    const handleAssistantError = useCallback((payload = {}) => {
        const messageId = payload.messageId;
        const message = payload?.error?.message || payload.message || 'Assistant error';
        const finalText = `Assistant error: ${message}`;
        setMessages((prev) => {
            let updated = false;
            const next = prev.map((msg) => {
                if (messageId && msg.id === messageId) {
                    updated = true;
                    return { ...msg, text: finalText, isFinal: true };
                }
                return msg;
            });
            if (!updated) {
                next.push({
                    id: messageId || `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    text: finalText,
                    isFinal: true,
                    ts: Date.now(),
                    side: 'right'
                });
            }
            return next;
        });
    }, []);

    const attachAssistantEvents = useCallback(() => {
        if (typeof electronAPI?.assistant?.onEvent !== 'function') {
            return;
        }
        resetAssistantListener();
        assistantListenerRef.current = electronAPI.assistant.onEvent((payload = {}) => {
            const { type, sessionId } = payload;
            if (!type) {
                return;
            }
            if (sessionId && assistantSessionIdRef.current && sessionId !== assistantSessionIdRef.current && type !== 'stopped') {
                return;
            }
            switch (type) {
                case 'started':
                    assistantSessionIdRef.current = sessionId || assistantSessionIdRef.current;
                    break;
                case 'update':
                    updateAssistantMessage(payload);
                    if (payload.isFinal) {
                        assistantSessionIdRef.current = null;
                    }
                    break;
                case 'error':
                    handleAssistantError(payload);
                    assistantSessionIdRef.current = null;
                    break;
                case 'stopped':
                    assistantSessionIdRef.current = null;
                    break;
                default:
                    break;
            }
        });
    }, [handleAssistantError, resetAssistantListener, updateAssistantMessage]);

    const attachImageToDraft = useCallback(async (image) => {
        if (image?.error) {
            appendAssistantNotice(`Capture error: ${image.error}`);
            return { ok: false, reason: 'capture-error' };
        }
        if (!image || !image.data || !image.mime) {
            appendAssistantNotice('Capture failed: missing image data.');
            return { ok: false, reason: 'invalid-image' };
        }
        if (assistantRequestInFlightRef.current) {
            return { ok: false, reason: 'busy' };
        }
        if (typeof electronAPI?.assistant?.attachImage !== 'function') {
            appendAssistantNotice('Assistant image attach is unavailable.');
            return { ok: false, reason: 'unavailable' };
        }
        try {
            const conversationId = ensureConversationId();
            const response = await electronAPI.assistant.attachImage({
                draftId: imageDraftIdRef.current,
                image,
                conversationId
            });
            if (!response?.ok) {
                const message = response?.error?.message || 'Failed to attach image.';
                appendAssistantNotice(message);
                return { ok: false, reason: 'error' };
            }
            imageDraftIdRef.current = response.draftId;
            const metadataList = Array.isArray(response.attachments) ? response.attachments : [];
            const latestMeta = metadataList.at(-1);
            const preview = buildAttachmentPreview({
                image,
                metadata: latestMeta,
                fallbackId: `${response.draftId || 'draft'}-${metadataList.length || 0}-${Date.now()}`
            });
            upsertImageBubble({ draftId: response.draftId, attachments: [preview] });
            return { ok: true, draftId: response.draftId, attachments: response.attachments };
        } catch (error) {
            appendAssistantNotice(`Assistant error: ${error?.message || 'Unknown error'}`);
            return { ok: false, error };
        }
    }, [appendAssistantNotice, ensureConversationId, upsertImageBubble]);

    const requestAssistantResponse = useCallback(async () => {
        if (assistantRequestInFlightRef.current) {
            return { ok: false, reason: 'busy' };
        }
        const pendingMessages = (messagesRef.current || []).filter((msg) => {
            if (msg.sent === true) return false;
            if (msg.side === 'left' && typeof msg.text === 'string' && msg.text.trim().length > 0) return true;
            if (msg.side === 'right' && msg.type === 'image' && Array.isArray(msg.attachments) && msg.attachments.length > 0) return true;
            return false;
        });
        if (pendingMessages.length === 0) {
            appendAssistantNotice('no new message available to send');
            return { ok: false, reason: 'no-unsent' };
        }

        const transcriptQueue = pendingMessages.filter((msg) => msg.side === 'left');
        const transcriptPayload = transcriptQueue
            .map((msg) => {
                const rawText = typeof msg.text === 'string' ? msg.text : '';
                if (!rawText) {
                    return null;
                }
                const speaker = msg.sourceType === TRANSCRIPTION_SOURCE_TYPES.MIC ? 'user' : 'interviewer';
                return {
                    id: msg.id,
                    messageBy: speaker,
                    message: rawText
                };
            })
            .filter(Boolean);

        const conversationId = ensureConversationId();
        assistantRequestInFlightRef.current = true;
        try {
            if (typeof electronAPI?.assistant?.finalizeDraft !== 'function') {
                throw new Error('Assistant finalize API is unavailable.');
            }
            const response = await electronAPI.assistant.finalizeDraft({
                draftId: imageDraftIdRef.current,
                messages: transcriptPayload,
                conversationId
            });
            const { sessionId, messageId, draftId, conversationId: responseConversationId } = response || {};
            if (!response?.ok || !sessionId || !messageId) {
                const message = response?.error?.message || 'Assistant response is missing identifiers.';
                throw new Error(message);
            }
            conversationIdRef.current = responseConversationId || conversationId;
            assistantSessionIdRef.current = sessionId;
            const now = Date.now();
            const sentIds = new Set(pendingMessages.map((msg) => msg.id));
            setMessages((prev) => {
                const updated = prev.map((msg) => {
                    if (sentIds.has(msg.id)) {
                        return { ...msg, sent: true, isFinal: true };
                    }
                    return msg;
                });
                const alreadyHasMessage = updated.some((msg) => msg.id === messageId);
                if (alreadyHasMessage) {
                    return updated;
                }
                return [
                    ...updated,
                    {
                        id: messageId,
                        text: 'Thinking...',
                        isFinal: false,
                        ts: now,
                        side: 'right',
                        assistantSessionId: sessionId
                    }
                ];
            });
            imageDraftIdRef.current = null;
            return { ok: true, sessionId, messageId, draftId };
        } catch (error) {
            appendAssistantNotice(`Assistant error: ${error?.message || 'Unknown error'}`);
            return { ok: false, error };
        } finally {
            assistantRequestInFlightRef.current = false;
        }
    }, [appendAssistantNotice, ensureConversationId]);

    return useMemo(() => ({
        status,
        setStatus,
        messages,
        latencyStatus,
        isStreaming,
        clearTranscript,
        startTranscriptionSession,
        stopTranscriptionSession,
        teardownSession,
        attachTranscriptionEvents,
        attachAssistantEvents,
        requestAssistantResponse,
        attachImageToDraft,
        getSessionId,
        getSessionIdForSource: getSessionId,
        startSourceSession: startTranscriptionSession,
        stopSourceSession: stopTranscriptionSession,
        isSourceStreaming,
        notification
    }), [
        attachAssistantEvents,
        attachTranscriptionEvents,
        attachImageToDraft,
        clearTranscript,
        getSessionId,
        isSourceStreaming,
        isStreaming,
        latencyStatus,
        notification,
        requestAssistantResponse,
        messages,
        startTranscriptionSession,
        status,
        stopTranscriptionSession,
        teardownSession
    ]);
}
