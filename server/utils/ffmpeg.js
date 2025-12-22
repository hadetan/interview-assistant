const fs = require('node:fs');

function preferUnpackedBinary(candidatePath) {
    if (typeof candidatePath !== 'string') {
        return candidatePath;
    }

    const trimmed = candidatePath.trim();
    if (!trimmed) {
        return trimmed;
    }

    if (trimmed.includes('app.asar.unpacked')) {
        return trimmed;
    }

    if (!trimmed.includes('app.asar')) {
        return trimmed;
    }

    const unpackedPath = trimmed.replace('app.asar', 'app.asar.unpacked');
    try {
        if (fs.existsSync(unpackedPath)) {
            return unpackedPath;
        }
    } catch (_error) {
        // Ignore filesystem probe errors so we can fall back to the original path.
    }

    return trimmed;
}

let bundledPath;
let attemptedLoad = false;

function loadBundledFfmpegPath() {
    if (attemptedLoad) {
        return bundledPath;
    }
    attemptedLoad = true;
    try {
        const installer = require('@ffmpeg-installer/ffmpeg');
        if (installer?.path) {
            const candidate = preferUnpackedBinary(installer.path);
            if (typeof candidate === 'string' && fs.existsSync(candidate)) {
                bundledPath = candidate;
            } else if (typeof installer.path === 'string' && fs.existsSync(installer.path)) {
                bundledPath = installer.path;
            } else {
                bundledPath = candidate;
            }
        } else {
            bundledPath = null;
        }
    } catch (error) {
        bundledPath = null;
    }
    return bundledPath;
}

function resolveFfmpegPath(explicitPath) {
    const normalized = typeof explicitPath === 'string' && explicitPath.trim().length > 0
        ? preferUnpackedBinary(explicitPath)
        : null;
    if (normalized) {
        return normalized;
    }

    const envPath = typeof process.env.TRANSCRIPTION_FFMPEG_PATH === 'string'
        ? preferUnpackedBinary(process.env.TRANSCRIPTION_FFMPEG_PATH)
        : null;
    if (envPath) {
        return envPath;
    }

    const fallback = preferUnpackedBinary(loadBundledFfmpegPath());
    if (fallback) {
        return fallback;
    }

    return null;
}

function hasBundledFfmpeg() {
    return Boolean(loadBundledFfmpegPath());
}

module.exports = {
    resolveFfmpegPath,
    hasBundledFfmpeg
};
