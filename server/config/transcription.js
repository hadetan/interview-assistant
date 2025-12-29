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
        TRANSCRIPTION_API_KEY,
        TRANSCRIPTION_FFMPEG_PATH,
        TRANSCRIPTION_MAX_PENDING_CHUNK_MS,
        TRANSCRIPTION_TARGET_PCM_CHUNK_MS,
        TRANSCRIPTION_SILENCE_FILLER_INTERVAL_MS
    } = process.env;

    const transcriptAiConfig = {
        ASSEMBLYAI_MAX_TURN_SILENCE_MS: null,
        ASSEMBLYAI_MIN_END_OF_TURN_SILENCE_MS: null,
        ASSEMBLYAI_EOT_CONFIDENCE_THRESHOLD: null
    }
    const provider = (TRANSCRIPTION_PROVIDER || 'assembly').toLowerCase();
    const ffmpegPath = resolveFfmpegPath(TRANSCRIPTION_FFMPEG_PATH);
    const apiKey = typeof TRANSCRIPTION_API_KEY === 'string' && TRANSCRIPTION_API_KEY.trim() !== ''
        ? TRANSCRIPTION_API_KEY.trim()
        : null;

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

    const maxPendingChunkMs = clamp(toInteger(TRANSCRIPTION_MAX_PENDING_CHUNK_MS, 45), 20, 200);
    const targetPcmChunkMs = clamp(toInteger(TRANSCRIPTION_TARGET_PCM_CHUNK_MS, 60), 20, 160);
    const silenceFillerIntervalMs = clamp(toInteger(TRANSCRIPTION_SILENCE_FILLER_INTERVAL_MS, 240), 80, 2000);
    const deepgramParams = {
        model: 'nova-3',
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        smart_format: true,
        interim_results: true,
        punctuate: true
    };

    return {
        provider,
        ffmpegPath,
        providerConfig: {
            assembly: {
                apiKey,
                ffmpegPath
            },
            deepgram: {
                apiKey,
                ffmpegPath
            }
        },
        streaming: {
            maxChunkBytes: 128 * 1024,
            maxPendingChunkMs,
            targetPcmChunkMs,
            silenceFillerIntervalMs,
            heartbeatIntervalMs: 250,
            silenceNotifyMs: 600,
            silenceSuppressMs: 900,
            silenceEnergyThreshold: 350,
            reconnectBackoffMs: 750,
            maxReconnectAttempts: 6,
            socketKeepaliveMs: 0,
            vad: {
                enabled: true,
                frameMs: 30,
                aggressiveness: clamp(2, 0, 3),
                minSpeechRatio: clamp(0.2, 0.01, 1),
                speechHoldMs: 300,
                silenceHoldMs: 200
            },
            assemblyParams,
            deepgramParams
        }
    };
};
