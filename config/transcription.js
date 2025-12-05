const toInteger = (value, defaultValue) => {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
};

module.exports = function loadTranscriptionConfig() {
    const {
        TRANSCRIPTION_PROVIDER,
        TRANSCRIPTION_MODEL,
        TRANSCRIPTION_TIMEOUT_MS,
        TRANSCRIPTION_CHUNK_TIMESLICE_MS,
        TRANSCRIPTION_MAX_CHUNK_BYTES,
        TRANSCRIPTION_PROMPT,
        TRANSCRIPTION_SILENCE_FILL_MS,
        TRANSCRIPTION_SILENCE_FRAME_MS,
        GEMINI_API_KEY
    } = process.env;

    const provider = (TRANSCRIPTION_PROVIDER || 'gemini').toLowerCase();

    return {
        provider,
        model: TRANSCRIPTION_MODEL || 'models/gemini-1.5-flash-latest',
        providerConfig: {
            gemini: {
                apiKey: GEMINI_API_KEY || null,
                model: TRANSCRIPTION_MODEL || 'models/gemini-1.5-flash-latest',
                timeoutMs: toInteger(TRANSCRIPTION_TIMEOUT_MS, 90_000)
            }
        },
        streaming: {
            chunkTimesliceMs: toInteger(TRANSCRIPTION_CHUNK_TIMESLICE_MS, 200),
            maxChunkBytes: toInteger(TRANSCRIPTION_MAX_CHUNK_BYTES, 128 * 1024),
            prompt: TRANSCRIPTION_PROMPT || 'Transcribe the incoming system audio. Respond with lower-case plain text, no timestamps, no speaker labels.',
            silenceFillMs: toInteger(TRANSCRIPTION_SILENCE_FILL_MS, 200),
            silenceFrameMs: toInteger(TRANSCRIPTION_SILENCE_FRAME_MS, 20)
        }
    };
};
