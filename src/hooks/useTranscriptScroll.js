import { useCallback, useEffect, useRef, useState } from 'react';

export function useTranscriptScroll({ messages, autoScroll = true }) {
    const transcriptRef = useRef(null);
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
        el.scrollTo({ top: nextTop, behavior: 'smooth' });
        const atBottom = nextTop >= maxScrollTop - 2;
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
            const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
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
            return;
        }
        const id = window.requestAnimationFrame(scrollToBottom);
        return () => window.cancelAnimationFrame(id);
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
