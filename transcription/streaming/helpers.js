const LOG_PREFIX = '[Transcription:Streaming]';

const log = (level, message, ...args) => {
    const stamp = new Date().toISOString();
    const logger = console[level] || console.log;
    logger(`${LOG_PREFIX} ${stamp} ${message}`, ...args);
};

const clampNumber = (value, min, max) => {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, value));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const analyzePcmChunk = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
        return { rms: 0, peak: 0 };
    }
    let peak = 0;
    let sumSquares = 0;
    let samples = 0;
    for (let i = 0; i < buffer.length - 1; i += 2) {
        const sample = buffer.readInt16LE(i);
        samples += 1;
        const abs = Math.abs(sample);
        peak = abs > peak ? abs : peak;
        sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, samples));
    return { rms, peak };
};

const computeChunkDurationMs = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
        return 0;
    }
    const samples = Math.floor(buffer.length / 2);
    return Math.max(1, Math.round((samples / 16000) * 1000));
};

const computeLatencyBreakdown = (info) => {
    if (!info?.captureTs) {
        return null;
    }
    const now = Date.now();
    const captureToIpc = typeof info.ipcTs === 'number' ? Math.max(0, info.ipcTs - info.captureTs) : undefined;
    const ipcToService = typeof info.serviceReceivedTs === 'number'
        ? Math.max(0, info.serviceReceivedTs - (info.ipcTs ?? info.captureTs))
        : undefined;
    const serviceToConverter = typeof info.converterProducedTs === 'number'
        ? Math.max(0, info.converterProducedTs - (info.serviceReceivedTs ?? info.converterProducedTs))
        : undefined;
    const converterToWs = (typeof info.wsSendTs === 'number' && typeof info.converterProducedTs === 'number')
        ? Math.max(0, info.wsSendTs - info.converterProducedTs)
        : undefined;
    const wsToTranscript = typeof info.wsSendTs === 'number'
        ? Math.max(0, now - info.wsSendTs)
        : undefined;
    const total = Math.max(0, now - info.captureTs);
    return {
        captureToIpc,
        ipcToService,
        serviceToConverter,
        converterToWs,
        wsToTranscript,
        total
    };
};

module.exports = {
    LOG_PREFIX,
    log,
    clampNumber,
    sleep,
    analyzePcmChunk,
    computeChunkDurationMs,
    computeLatencyBreakdown
};
