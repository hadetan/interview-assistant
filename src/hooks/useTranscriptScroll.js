import { useCallback, useEffect, useRef, useState } from 'react';

const BOTTOM_EPSILON = 2;

export function useTranscriptScroll({ messages, autoScroll = true }) {
    const transcriptRef = useRef(null);
    const rafIdRef = useRef(null);
    const rafBaselineRef = useRef(0);
    const [isAtBottom, setIsAtBottom] = useState(true);

    const scrollToBottom = useCallback(() => {
        const el = transcriptRef.current;
        if (!el) {
            return;
        }
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTo({ top: maxScrollTop, behavior: 'auto' });
    }, []);

    const scrollBy = useCallback((delta) => {
        const el = transcriptRef.current;
        if (!el) {
            return;
        }
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        const nextTop = Math.min(maxScrollTop, Math.max(0, el.scrollTop + delta));
        el.scrollTop = nextTop;
        const atBottom = Math.abs(maxScrollTop - nextTop) <= BOTTOM_EPSILON;
        setIsAtBottom(atBottom);
    }, []);

    const resetScroll = useCallback(() => {
        const el = transcriptRef.current;
        if (!el) {
            return;
        }
        el.scrollTop = 0;
        setIsAtBottom(true);
    }, []);

    useEffect(() => {
        const el = transcriptRef.current;
        if (!el) {
            return () => {};
        }
        const handleScroll = () => {
            const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
            const atBottom = Math.abs(maxScrollTop - el.scrollTop) <= BOTTOM_EPSILON;
            setIsAtBottom(atBottom);
        };
        handleScroll();
        el.addEventListener('scroll', handleScroll, { passive: true });
        return () => {
            el.removeEventListener('scroll', handleScroll);
        };
    }, [transcriptRef]);

    useEffect(() => {
        if (!autoScroll || !isAtBottom) {
            if (rafIdRef.current !== null) {
                window.cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
            }
            return;
        }
        const el = transcriptRef.current;
        if (!el) {
            return () => {};
        }
        if (rafIdRef.current !== null) {
            window.cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
        rafBaselineRef.current = el.scrollTop;
        rafIdRef.current = window.requestAnimationFrame(() => {
            rafIdRef.current = null;
            const current = transcriptRef.current;
            if (!current) {
                return;
            }
            const userMoved = Math.abs(current.scrollTop - rafBaselineRef.current) > BOTTOM_EPSILON;
            if (userMoved) {
                return;
            }
            scrollToBottom();
        });
        return () => {
            if (rafIdRef.current !== null) {
                window.cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
            }
        };
    }, [autoScroll, isAtBottom, messages, scrollToBottom]);

    return {
        transcriptRef,
        isAtBottom,
        scrollBy,
        resetScroll,
        scrollToBottom,
        setIsAtBottom
    };
}
