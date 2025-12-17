const PLACEHOLDER = 'Thinking...';

export function mergeAssistantText(previousText, { delta = '', serverText } = {}) {
    const prev = typeof previousText === 'string' ? previousText : '';
    const hasServerText = typeof serverText === 'string' && serverText.length > 0;
    const hasDelta = typeof delta === 'string' && delta.length > 0;

    if (!hasServerText && !hasDelta) {
        return { text: prev, didUpdate: false };
    }

    if (hasServerText) {
        return { text: serverText, didUpdate: serverText !== prev };
    }

    const base = prev === PLACEHOLDER ? '' : prev;
    const next = `${base}${delta}`;
    return { text: next, didUpdate: next !== prev };
}
