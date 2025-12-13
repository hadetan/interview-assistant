require('dotenv').config();

const { resolveFfmpegPath } = require('../utils/ffmpeg');

const toInteger = (value, defaultValue) => {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
};

const toNumber = (value, defaultValue) => {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
};

const clamp = (value, min, max) => {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, value));
};

module.exports = function loadTranscriptionConfig() {
    const {
        TRANSCRIPTION_PROVIDER,
        ASSEMBLYAI_API_KEY,
        TRANSCRIPTION_FFMPEG_PATH,
    } = process.env;

    const transcriptAiConfig = {
        ASSEMBLYAI_MAX_TURN_SILENCE_MS: null,
        ASSEMBLYAI_MIN_END_OF_TURN_SILENCE_MS: null,
        ASSEMBLYAI_EOT_CONFIDENCE_THRESHOLD: null
    }
    const provider = (TRANSCRIPTION_PROVIDER || 'assembly').toLowerCase();
    const ffmpegPath = resolveFfmpegPath(TRANSCRIPTION_FFMPEG_PATH);

    const assemblyParams = {};
    const maxTurnSilence = toInteger(transcriptAiConfig.ASSEMBLYAI_MAX_TURN_SILENCE_MS, null);
    if (Number.isInteger(maxTurnSilence) && maxTurnSilence > 0) {
        assemblyParams.maxTurnSilence = maxTurnSilence;
    }
    const minConfidentSilence = toInteger(transcriptAiConfig.ASSEMBLYAI_MIN_END_OF_TURN_SILENCE_MS, null);
    if (Number.isInteger(minConfidentSilence) && minConfidentSilence > 0) {
        assemblyParams.minEndOfTurnSilenceWhenConfident = minConfidentSilence;
    }
    const endOfTurnConfidence = toNumber(transcriptAiConfig.ASSEMBLYAI_EOT_CONFIDENCE_THRESHOLD, null);
    if (typeof endOfTurnConfidence === 'number' && !Number.isNaN(endOfTurnConfidence)) {
        assemblyParams.endOfTurnConfidenceThreshold = endOfTurnConfidence;
    }

    return {
        provider,
        ffmpegPath,
        providerConfig: {
            assembly: {
                apiKey: ASSEMBLYAI_API_KEY || null,
                ffmpegPath
            }
        },
        streaming: {
            maxChunkBytes: 128 * 1024,
            maxPendingChunkMs: 150,
            silenceFillMs: 200,
            silenceFrameMs: 120,
            heartbeatIntervalMs: 250,
            silenceNotifyMs: 600,
            silenceSuppressMs: 900,
            silenceEnergyThreshold: 350,
            silenceFailureThreshold: 5,
            silenceBackoffMs: 10000,
            reconnectBackoffMs: 750,
            maxReconnectAttempts: 6,
            vad: {
                frameMs: 30,
                aggressiveness: clamp(2, 0, 3),
                minSpeechRatio: clamp(0.2, 0.01, 1),
                speechHoldMs: Math.max(0, 300),
                silenceHoldMs: Math.max(0, 200),
                fillerHoldMs: Math.max(0, 600)
            },
            assemblyParams
        }
    };
};
