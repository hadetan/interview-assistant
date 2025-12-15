import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mergeText } from '../utils/mergeText';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;
const STALL_THRESHOLD_MS = 1500;
const STALL_WATCH_INTERVAL_MS = 1000;
const CONTINUATION_LINGER_MS = 2500;

export function useTranscriptionSession({ isControlWindow }) {
    const [status, setStatus] = useState('Idle');
    const [messages, setMessages] = useState([]);
    const [latencyStatus, setLatencyStatus] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);

    const sessionIdRef = useRef(null);
    const stopTranscriptionListenerRef = useRef(null);
    const pendingMessageIdRef = useRef(null);
    const continuationMessageIdRef = useRef(null);
    const lastMessageUpdateTsRef = useRef(0);
    const latencyTimerRef = useRef(null);
    const lastLatencyTsRef = useRef(0);
    const latencyLabelRef = useRef('');
    const latencySuffixRef = useRef('');
    const latencySuffixReasonRef = useRef('');

    const resetTranscriptionListener = useCallback(() => {
        if (typeof stopTranscriptionListenerRef.current === 'function') {
            stopTranscriptionListenerRef.current();
        }
        stopTranscriptionListenerRef.current = null;
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

    const clearTranscript = useCallback(() => {
        pendingMessageIdRef.current = null;
        continuationMessageIdRef.current = null;
        lastMessageUpdateTsRef.current = 0;
        setMessages([]);
    }, []);

    const teardownSession = useCallback(async () => {
        resetTranscriptionListener();
        const currentSessionId = sessionIdRef.current;
        sessionIdRef.current = null;
        if (isControlWindow && currentSessionId && electronAPI?.transcription?.stopSession) {
            try {
                await electronAPI.transcription.stopSession(currentSessionId);
            } catch (_error) {
                // ignore teardown failures
            }
        }
        pendingMessageIdRef.current = null;
        continuationMessageIdRef.current = null;
        lastMessageUpdateTsRef.current = 0;
        setMessages([]);
        setIsStreaming(false);
        resetLatencyWatchdog();
    }, [isControlWindow, resetLatencyWatchdog, resetTranscriptionListener]);

    const getSessionId = useCallback(() => sessionIdRef.current, []);

    const startTranscriptionSession = useCallback(async ({ sourceName, platform }) => {
        if (typeof electronAPI?.transcription?.startSession !== 'function') {
            throw new Error('Transcription start API unavailable.');
        }
        const response = await electronAPI.transcription.startSession({ sourceName, platform });
        sessionIdRef.current = response?.sessionId || null;
        return response;
    }, []);

    const stopTranscriptionSession = useCallback(async () => {
        if (!sessionIdRef.current || typeof electronAPI?.transcription?.stopSession !== 'function') {
            return;
        }
        const currentSessionId = sessionIdRef.current;
        sessionIdRef.current = null;
        try {
            await electronAPI.transcription.stopSession(currentSessionId);
        } catch (_error) {
            // ignore
        }
        resetLatencyWatchdog();
        setIsStreaming(false);
    }, [resetLatencyWatchdog]);

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

            if (isControlWindow) {
                if (!sessionIdRef.current || eventSessionId !== sessionIdRef.current) {
                    return;
                }
            } else if (!sessionIdRef.current && payload.type === 'started') {
                sessionIdRef.current = eventSessionId;
            } else if (sessionIdRef.current !== eventSessionId && payload.type !== 'stopped') {
                return;
            }

            switch (payload.type) {
                case 'started':
                    ensureLatencyWatchdog();
                    lastLatencyTsRef.current = Date.now();
                    latencyLabelRef.current = '';
                    latencySuffixRef.current = '';
                    setStatus('Streaming transcription active.');
                    setIsStreaming(true);
                    break;
                case 'update': {
                    const serverText = typeof payload.text === 'string' ? payload.text : '';
                    const delta = typeof payload.delta === 'string' ? payload.delta : '';
                    const isFinal = Boolean(payload.isFinal);
                    const content = delta || serverText;
                    const now = Date.now();
                    const lastUpdateTs = lastMessageUpdateTsRef.current || 0;
                    const canContinue = lastUpdateTs > 0 && (now - lastUpdateTs) <= CONTINUATION_LINGER_MS;
                    const continuationId = canContinue ? continuationMessageIdRef.current : null;
                    if (!canContinue) {
                        continuationMessageIdRef.current = null;
                    }
                    if (content) {
                        setMessages((prev) => {
                            const next = [...prev];
                            const pendingId = pendingMessageIdRef.current;
                            const targetId = pendingId || continuationId;

                            if (!isFinal) {
                                if (targetId) {
                                    const updated = next.map((msg) => {
                                        if (msg.id !== targetId) return msg;
                                        const appended = mergeText(msg.text, delta ? delta : serverText || content, Boolean(delta));
                                        return { ...msg, text: appended, isFinal: false };
                                    });
                                    pendingMessageIdRef.current = targetId;
                                    continuationMessageIdRef.current = targetId;
                                    lastMessageUpdateTsRef.current = now;
                                    return updated;
                                }
                                const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                                pendingMessageIdRef.current = id;
                                continuationMessageIdRef.current = id;
                                lastMessageUpdateTsRef.current = now;
                                next.push({ id, text: content, isFinal: false, ts: now, side: 'left' });
                                return next;
                            }

                            if (targetId) {
                                pendingMessageIdRef.current = null;
                                continuationMessageIdRef.current = targetId;
                                lastMessageUpdateTsRef.current = now;
                                return next.map((msg) => {
                                    if (msg.id !== targetId) return msg;
                                    const finalizedText = serverText
                                        ? serverText
                                        : mergeText(msg.text, delta ? delta : content, Boolean(delta));
                                    return { ...msg, text: finalizedText, isFinal: true };
                                });
                            }

                            const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                            pendingMessageIdRef.current = null;
                            continuationMessageIdRef.current = id;
                            lastMessageUpdateTsRef.current = now;
                            next.push({ id, text: serverText || content, isFinal: true, ts: now, side: 'left' });
                            return next;
                        });
                    }
                    lastLatencyTsRef.current = Date.now();
                    latencyLabelRef.current = `WS ${payload.latencyMs ?? '-'}ms | E2E ${payload.pipelineMs ?? '-'}ms | CONV ${payload.conversionMs ?? '-'}ms`;
                    latencySuffixRef.current = '';
                    latencySuffixReasonRef.current = '';
                    ensureLatencyWatchdog();
                    updateLatencyStatus();
                    break;
                }
                case 'warning':
                    resetLatencyWatchdog();
                    latencySuffixRef.current = '';
                    latencySuffixReasonRef.current = '';
                    setStatus(`Transcription warning: ${payload.warning?.message || payload.warning?.code || payload.message || 'Unknown warning'}`);
                    break;
                case 'error':
                    resetLatencyWatchdog();
                    latencySuffixRef.current = '';
                    latencySuffixReasonRef.current = '';
                    setStatus(`Transcription error: ${payload.error?.message || 'Unknown error'}`);
                    break;
                case 'stopped':
                    resetLatencyWatchdog();
                    latencySuffixRef.current = '';
                    latencySuffixReasonRef.current = '';
                    setStatus('Transcription session stopped.');
                    pendingMessageIdRef.current = null;
                    setMessages([]);
                    setIsStreaming(false);
                    continuationMessageIdRef.current = null;
                    lastMessageUpdateTsRef.current = 0;
                    if (!isControlWindow) {
                        sessionIdRef.current = null;
                    }
                    break;
                case 'heartbeat': {
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
                    break;
                }
                default:
                    break;
            }
        });
    }, [ensureLatencyWatchdog, formatStalledLabel, isControlWindow, resetLatencyWatchdog, resetTranscriptionListener, updateLatencyStatus]);

    useEffect(() => () => {
        resetTranscriptionListener();
        resetLatencyWatchdog();
    }, [resetLatencyWatchdog, resetTranscriptionListener]);

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
        getSessionId
    }), [
        attachTranscriptionEvents,
        clearTranscript,
        getSessionId,
        isStreaming,
        latencyStatus,
        messages,
        startTranscriptionSession,
        status,
        stopTranscriptionSession,
        teardownSession
    ]);
}
