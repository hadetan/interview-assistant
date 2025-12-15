const TRAILING_WHITESPACE = /\s+$/g;
const LEADING_WHITESPACE = /^\s+/g;
const WORD_CHAR_END = /[A-Za-z0-9]$/;
const WORD_CHAR_START = /^[A-Za-z0-9]/;
const LEADING_PUNCTUATION = /^[,.;:!?]/;

/**
 * Merge incremental transcript text while minimizing duplicated overlap and
 * ensuring human-friendly spacing.
 */
export function mergeText(base, incoming, preferAppend = false) {
    const safeBase = base || '';
    const safeIncoming = incoming || '';

    if (!safeIncoming) {
        return safeBase;
    }
    if (!safeBase) {
        return safeIncoming;
    }
    if (safeIncoming === safeBase) {
        return safeBase;
    }

    const baseTrimRight = preferAppend
        ? safeBase
        : safeBase.replace(TRAILING_WHITESPACE, '');
    const incomingTrimLeft = preferAppend
        ? safeIncoming
        : safeIncoming.replace(LEADING_WHITESPACE, '');

    if (incomingTrimLeft.startsWith(baseTrimRight)) {
        return incomingTrimLeft;
    }
    if (baseTrimRight.endsWith(incomingTrimLeft)) {
        return baseTrimRight;
    }

    let overlap = 0;
    const maxOverlap = Math.min(baseTrimRight.length, incomingTrimLeft.length);
    for (let k = maxOverlap; k > 0; k -= 1) {
        if (baseTrimRight.slice(baseTrimRight.length - k) === incomingTrimLeft.slice(0, k)) {
            overlap = k;
            break;
        }
    }

    const remainder = incomingTrimLeft.slice(overlap);
    const needsSpace = remainder
        && overlap === 0
        && WORD_CHAR_END.test(baseTrimRight)
        && WORD_CHAR_START.test(remainder)
        && !LEADING_PUNCTUATION.test(remainder)
        && !TRAILING_WHITESPACE.test(baseTrimRight);

    const joined = `${baseTrimRight}${needsSpace ? ' ' : ''}${remainder}`;
    return preferAppend ? joined : joined;
}
