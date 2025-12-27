export const clampOpacity = (value, min = 0.25, max = 1) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return min;
    }
    if (numeric < min) {
        return min;
    }
    if (numeric > max) {
        return max;
    }
    return numeric;
};

const formatCssValue = (value) => {
    const safe = Number.isFinite(value) ? value : 0;
    return String(Math.min(1, Math.max(0, Number.parseFloat(safe.toFixed(3)))));
};

const derive = (base, factor) => formatCssValue(Math.min(1, Math.max(0, base * factor)));

export const computeTranscriptOpacityVars = (opacity) => {
    const base = clampOpacity(opacity);
    return {
        '--transcript-surface-opacity': formatCssValue(base),
        '--transcript-body-opacity': derive(base, 0.82),
        '--transcript-guide-opacity': derive(base, 0.7),
        '--transcript-card-opacity': derive(base, 0.65),
        '--transcript-shortcut-opacity': derive(base, 0.55),
        '--transcript-bubble-opacity': formatCssValue(Math.min(0.35, Math.max(0.05, base * 0.14))),
        '--transcript-placeholder-opacity': derive(base, 0.6)
    };
};

export const TRANSCRIPT_OPACITY_OPTIONS = [
    { label: '0.25', value: 0.25 },
    { label: '0.50', value: 0.5 },
    { label: '0.75', value: 0.75 },
    { label: '1.00', value: 1 }
];
