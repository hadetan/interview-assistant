const FENCE_PATTERN = /```(?:(\w+)[ \t]*)?\r?\n([\s\S]*?)```/g;

export function parseFencedCode(text = '') {
    const safeText = typeof text === 'string' ? text : String(text ?? '');
    const segments = [];

    if (!safeText) {
        return [{ type: 'text', text: '' }];
    }

    let cursor = 0;
    let match;

    while ((match = FENCE_PATTERN.exec(safeText)) !== null) {
        const [fullMatch, langGroup, codeGroup] = match;
        const matchIndex = match.index;
        if (matchIndex > cursor) {
            segments.push({ type: 'text', text: safeText.slice(cursor, matchIndex) });
        }

        segments.push({
            type: 'code',
            language: langGroup ? langGroup.trim() : undefined,
            code: codeGroup ?? ''
        });
        cursor = matchIndex + fullMatch.length;
    }

    if (cursor < safeText.length) {
        segments.push({ type: 'text', text: safeText.slice(cursor) });
    }

    const fenceCount = (safeText.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
        segments.push({ type: 'error', text: 'Unclosed code block detected.' });
    }

    if (segments.length === 0) {
        segments.push({ type: 'text', text: '' });
    }

    return segments;
}
