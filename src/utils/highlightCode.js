import hljs from 'highlight.js/lib/common';
import createDOMPurify from 'dompurify';

let domPurifyInstance = null;

function resolveWindow() {
    if (typeof window !== 'undefined' && window?.document) {
        return window;
    }
    if (typeof globalThis !== 'undefined' && globalThis.window?.document) {
        return globalThis.window;
    }
    return null;
}

function getDOMPurify() {
    if (domPurifyInstance) {
        return domPurifyInstance;
    }
    const win = resolveWindow();
    if (!win) {
        throw new Error('highlightCode requires a DOM window environment');
    }
    domPurifyInstance = createDOMPurify(win);
    return domPurifyInstance;
}

export function highlightCode(code = '', language) {
    const safeCode = typeof code === 'string' ? code : String(code ?? '');
    const requestedLanguage = typeof language === 'string' ? language.trim() : '';

    let highlightResult;
    if (requestedLanguage && hljs.getLanguage(requestedLanguage)) {
        highlightResult = hljs.highlight(safeCode, { language: requestedLanguage });
    } else {
        highlightResult = hljs.highlightAuto(safeCode);
    }

    const sanitizer = getDOMPurify();
    const sanitizedHtml = sanitizer.sanitize(highlightResult.value, { USE_PROFILES: { html: true } });

    return {
        html: sanitizedHtml,
        language: highlightResult.language || requestedLanguage || 'plaintext'
    };
}
