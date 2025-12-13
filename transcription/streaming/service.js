const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { AssemblyLiveClient } = require('./providers/assembly-client');
const { PersistentAudioConverter } = require('./audio-converter');
const { createVadInstance } = require('./vad');

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

class MockStreamingClient extends EventEmitter {
    constructor() {
        super();
        this.counter = 0;
        this.connected = false;
    }

    async connect() {
        this.connected = true;
        log('info', 'Mock client connected');
    }

    async sendAudio(pcmBuffer) {
        if (!this.connected) return;
        this.counter += 1;
        // Simulate transcription response every few chunks
        if (this.counter % 3 === 0) {
            await sleep(100);
            this.emit('transcription', { text: `mock transcript ${this.counter}` });
        }
    }

    async disconnect() {
        this.connected = false;
        log('info', 'Mock client disconnected');
    }

    isReady() {
        return this.connected;
    }
}

/**
 * Live API Session using WebSocket connection with persistent audio conversion.
 * Uses a long-running ffmpeg process to convert WebM/Opus stream to PCM.
 */
class LiveStreamingSession extends EventEmitter {
    constructor(options) {
        super();
        this.id = options.sessionId;
        this.sourceName = options.sourceName;
        this.client = options.client;
        this.terminated = false;
        this.lastSequence = -1;
        this.transcript = '';
        this.inputMimeType = 'audio/webm;codecs=opus';
        this.audioConverter = null;
        this.chunkInfo = new Map();
        this.streamingConfig = options.streamingConfig || {};
        this.ffmpegPath = options.ffmpegPath || null;
        this.silenceFillMs = Math.max(50, Number(this.streamingConfig.silenceFillMs) || 1000);
        this.silenceFrameMs = Math.min(500, Math.max(50, Number(this.streamingConfig.silenceFrameMs) || 120));
        this.silenceInterval = null;
        this.lastSendTs = 0;
        this.lastChunkMeta = null;
        this.silenceFrameBuffer = null;
        this.lastServerTranscript = '';
        this.silenceFailureCount = 0;
        this.silenceSuppressedUntil = 0;
        this.maxSilenceFailures = Math.max(1, Number(this.streamingConfig.silenceFailureThreshold) || 5);
        this.silenceBackoffMs = Math.max(1000, Number(this.streamingConfig.silenceBackoffMs) || 10000);
        this.pcmBuffer = Buffer.alloc(0);
        this.pendingFlushTimer = null;
        this.maxPendingChunkMs = Math.max(50, Number(this.streamingConfig.maxPendingChunkMs) || 150);
        this.firstChunkMeta = null;
        this.TARGET_CHUNK_SIZE = 3200; // Target chunk size: ~100ms of audio (16000Hz * 2 bytes * 0.1s = 3200 bytes)
        this.heartbeatInterval = null;
        this.heartbeatIntervalMs = Math.max(100, Number(this.streamingConfig.heartbeatIntervalMs) || 250);
        this.silenceDurationMs = 0;
        this.silenceNotifyMs = Math.max(50, Number(this.streamingConfig.silenceNotifyMs) || 600);
        this.silenceSuppressMs = Math.max(this.silenceNotifyMs, Number(this.streamingConfig.silenceSuppressMs) || 900);
        this.silenceEnergyThreshold = Math.max(1, Number(this.streamingConfig.silenceEnergyThreshold) || 350);
        this.lastSpeechAt = Date.now();
        this.lastServerUpdateAt = 0;
        this.reconnecting = false;
        this.reconnectAttempt = 0;
        this.reconnectPromise = null;
        this.reconnectBackoffMs = Math.max(200, Number(this.streamingConfig.reconnectBackoffMs) || 750);
        this.maxReconnectAttempts = Math.max(1, Number(this.streamingConfig.maxReconnectAttempts) || 6);
        this.latestPcmStats = null;
        const vadCfg = this.streamingConfig.vad || {};
        this.vadConfig = {
            enabled: Boolean(vadCfg.enabled),
            frameMs: vadCfg.frameMs || 30,
            aggressiveness: clampNumber(vadCfg.aggressiveness ?? 2, 0, 3),
            minSpeechRatio: clampNumber(typeof vadCfg.minSpeechRatio === 'number' ? vadCfg.minSpeechRatio : 0.2, 0.01, 1),
            speechHoldMs: Math.max(0, vadCfg.speechHoldMs ?? 300),
            silenceHoldMs: Math.max(0, vadCfg.silenceHoldMs ?? 200),
            fillerHoldMs: Math.max(0, vadCfg.fillerHoldMs ?? 600)
        };
        this.vadInstance = null;
        this.vadLastSpeechTs = 0;
        this.vadSilenceAccumMs = 0;
        this.vadFillerSuppressed = false;
        this.latestVadStats = null;

        // Listen for transcription events from the Live API client
        this.client.on('transcription', (data) => {
            if (this.terminated) return;
            const absoluteText = typeof data.text === 'string' ? data.text : '';
            if (!absoluteText) {
                return;
            }
            const now = Date.now();
            this.lastServerUpdateAt = now;
            this.lastSpeechAt = now;
            this.silenceDurationMs = 0;

            const previousServer = this.lastServerTranscript || '';
            if (absoluteText === previousServer) {
                return;
            }

            let delta = '';
            if (absoluteText.startsWith(previousServer) && previousServer.length > 0) {
                delta = absoluteText.slice(previousServer.length);
                this.transcript = absoluteText;
            } else if (previousServer.endsWith(absoluteText) && absoluteText.length > 0) {
                return;
            } else if (absoluteText.includes(previousServer) && previousServer.length > 0) {
                // If the server text includes the previous server text but does not
                // start with it, we avoid treating it as authoritative because that
                // may drop an earlier prefix produced by the client or by another
                // message. Instead, fall back to overlap-based merging below.
                // We'll treat it via the overlap logic (fall-through).
            } else {
                // Find largest overlap between previousServer suffix and absoluteText prefix.
                const maxOverlap = Math.min(previousServer.length, absoluteText.length);
                let overlap = 0;
                for (let k = maxOverlap; k > 0; k -= 1) {
                    try {
                        if (previousServer.slice(previousServer.length - k) === absoluteText.slice(0, k)) {
                            overlap = k;
                            break;
                        }
                    } catch (err) { }
                }
                delta = absoluteText.slice(overlap);
                this.transcript = (this.transcript || '') + delta;
            }
            this.lastServerTranscript = absoluteText;

            const latencyMs = typeof data.latencyMs === 'number' ? data.latencyMs : undefined;
            let pipelineMs = undefined;
            try {
                const info = this.chunkInfo.get(this.lastSequence);
                if (info?.captureTs) {
                    pipelineMs = Date.now() - info.captureTs;
                }
                const breakdown = this.computeLatencyBreakdown(info);
                if (breakdown) {
                    log('info', `Session ${this.id} latency breakdown total:${breakdown.total}ms cap->ipc:${breakdown.captureToIpc ?? '-'}ms ipc->svc:${breakdown.ipcToService ?? '-'}ms svc->pcm:${breakdown.serviceToConverter ?? '-'}ms pcm->ws:${breakdown.converterToWs ?? '-'}ms ws->txt:${breakdown.wsToTranscript ?? '-'}ms`);
                }
            } catch (err) { }
            log('info', `Session ${this.id} update (${this.transcript.length} chars)`);
            this.emit('update', {
                text: this.transcript,
                delta,
                latencyMs,
                conversionMs: this.lastConversionMs,
                pipelineMs
            });
        });

        this.client.on('chunk-sent', (meta = {}) => {
            const sendTs = meta.wsSendTs || Date.now();
            this.lastSendTs = sendTs;
            if (typeof meta.sequence === 'number') {
                const info = this.chunkInfo.get(meta.sequence);
                if (info) {
                    info.wsSendTs = sendTs;
                    if (meta.segmentProducedTs) {
                        info.converterProducedTs = meta.segmentProducedTs;
                    }
                }
            }
        });

        this.client.on('error', (error) => {
            if (!this.terminated) {
                this.emit('error', error);
            }
        });

        this.client.on('disconnected', (detail = {}) => {
            if (this.terminated) {
                return;
            }
            log('warn', `Session ${this.id} disconnected unexpectedly (${detail.code ?? 'no-code'})`);
            this.emit('warning', {
                code: 'ws-disconnected',
                message: 'Realtime streaming socket disconnected',
                detail
            });
            this.scheduleReconnect();
        });
    }

    async start() {
        try {
            await this.client.connect();
            log('info', `Session ${this.id} Live API connected`);
            await this.initializeVad();
            const converterOptions = {
                mimeType: this.inputMimeType,
                ffmpegPath: this.ffmpegPath || undefined,
                onData: (pcmChunk, info) => {
                    if (this.terminated || pcmChunk.length === 0) {
                        return;
                    }
                    try {
                        const producedAt = info?.producedAt;
                        if (this.pcmBuffer.length === 0) {
                            this.firstChunkMeta = this.buildChunkMeta(producedAt);
                        }

                        this.pcmBuffer = Buffer.concat([this.pcmBuffer, pcmChunk]);

                        if (this.pcmBuffer.length >= this.TARGET_CHUNK_SIZE) {
                            this.flushAccumulatedAudio();
                        } else {
                            this.schedulePendingFlush();
                        }
                    } catch (err) {
                        log('error', `Session ${this.id} failed to process audio: ${err.message}`);
                    }
                },
                onError: (error) => {
                    log('error', `Session ${this.id} audio converter error: ${error.message}`);
                }
            };

            if (this.ffmpegPath) {
                log('info', `Session ${this.id} using FFmpeg binary at ${this.ffmpegPath}`);
            } else {
                log('info', `Session ${this.id} using FFmpeg from system PATH`);
            }

            this.audioConverter = new PersistentAudioConverter(converterOptions);
            this.audioConverter.start();
            this.startHeartbeat();
            this.startSilenceFiller();

        } catch (error) {
            log('error', `Session ${this.id} failed to connect: ${error.message}`);
            throw error;
        }
    }

    /**
     * Add a chunk of audio data
     * @param {Object} chunk - { buffer: Buffer, mimeType: string, sequence: number }
     */
    addChunk(chunk) {
        if (this.terminated) {
            return;
        }
        if (!chunk?.buffer?.length) {
            return;
        }

        if (typeof chunk.sequence === 'number' && chunk.sequence <= this.lastSequence) {
            log('warn', `Session ${this.id} skipped out-of-order chunk (seq ${chunk.sequence})`);
            return;
        }

        this.lastSequence = typeof chunk.sequence === 'number' ? chunk.sequence : this.lastSequence;
        // record client provided timestamp for the sequence, useful for latency metrics
        if (typeof chunk.sequence === 'number') {
            const captureTs = chunk.captureTimestamp || chunk.clientTimestamp;
            const meta = {
                sequence: chunk.sequence,
                captureTs,
                clientTs: chunk.clientTimestamp,
                ipcTs: chunk.ipcTimestamp,
                serviceReceivedTs: Date.now()
            };
            this.chunkInfo.set(chunk.sequence, meta);
            this.lastChunkMeta = meta;
            if (this.chunkInfo.size > 512) {
                const keys = Array.from(this.chunkInfo.keys()).sort((a, b) => a - b);
                for (let i = 0; i < (keys.length - 256); i += 1) {
                    this.chunkInfo.delete(keys[i]);
                }
            }
        }

        if (this.audioConverter) {
            this.lastChunkReceivedAt = Date.now();
            this.audioConverter.push(chunk.buffer);
        }
    }

    async stop() {
        this.terminated = true;
        this.stopHeartbeat();
        this.reconnecting = false;

        if (this.reconnectPromise) {
            try {
                await this.reconnectPromise;
            } catch (_err) { }
            this.reconnectPromise = null;
        }

        if (this.audioConverter) {
            this.audioConverter.stop();
            this.audioConverter = null;
        }

        this.teardownVad();
        this.clearPendingFlushTimer();

        // Flush any remaining audio in the buffer
        if (this.pcmBuffer && this.pcmBuffer.length > 0) {
            try {
                log('info', `Session ${this.id} flushing remaining ${this.pcmBuffer.length} bytes`);
                this.flushAccumulatedAudio({ force: true, allowTerminated: true });
            } catch (err) {
                log('warn', `Session ${this.id} failed to flush audio: ${err.message}`);
            }
        }

        this.stopSilenceFiller();

        try {
            await this.client.disconnect();
        } catch (error) {
            log('warn', `Session ${this.id} disconnect error: ${error.message}`);
        }
    }

    buildChunkMeta(producedAt) {
        const meta = this.lastChunkMeta ? { ...this.lastChunkMeta } : {};
        if (this.lastChunkMeta) {
            this.lastChunkMeta.converterProducedTs = producedAt;
        }
        meta.segmentProducedTs = producedAt;
        if (typeof meta.sequence !== 'number') {
            meta.sequence = this.lastSequence;
        }
        return meta;
    }

    computeLatencyBreakdown(info) {
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
    }

    async initializeVad() {
        if (!this.vadConfig.enabled || this.vadInstance) {
            return;
        }
        try {
            this.vadInstance = await createVadInstance({
                sampleRate: 16000,
                frameMs: this.vadConfig.frameMs,
                aggressiveness: this.vadConfig.aggressiveness
            });
            this.vadLastSpeechTs = 0;
            this.vadSilenceAccumMs = 0;
            this.vadFillerSuppressed = false;
            log('info', `Session ${this.id} VAD ready (frame ${this.vadConfig.frameMs}ms, mode ${this.vadConfig.aggressiveness})`);
        } catch (error) {
            this.vadInstance = null;
            this.vadConfig.enabled = false;
            log('warn', `Session ${this.id} VAD disabled: ${error.message}`);
        }
    }

    teardownVad() {
        if (this.vadInstance) {
            try {
                this.vadInstance.dispose();
            } catch (error) {
                log('warn', `Session ${this.id} VAD dispose failed: ${error.message}`);
            }
        }
        this.vadInstance = null;
        this.latestVadStats = null;
        this.vadLastSpeechTs = 0;
        this.vadSilenceAccumMs = 0;
        this.vadFillerSuppressed = false;
    }

    evaluateVadDecision(buffer, chunkDurationMs, fallbackSpeech) {
        if (!this.vadInstance) {
            return {
                shouldSend: fallbackSpeech,
                audioSpeech: fallbackSpeech,
                holdActive: false,
                speechRatio: null,
                frameCount: 0,
                speechFrames: 0,
                silenceAccumMs: this.vadSilenceAccumMs
            };
        }

        const stats = this.vadInstance.analyze(buffer);
        const now = Date.now();
        const hasFrames = stats.frameCount > 0;
        const audioSpeech = hasFrames
            ? stats.speechRatio >= this.vadConfig.minSpeechRatio
            : fallbackSpeech;

        if (audioSpeech) {
            this.vadLastSpeechTs = now;
            this.vadSilenceAccumMs = 0;
        } else {
            this.vadSilenceAccumMs = Math.min(60_000, this.vadSilenceAccumMs + chunkDurationMs);
        }

        const holdActive = Boolean(
            this.vadConfig.speechHoldMs > 0
            && this.vadLastSpeechTs
            && (now - this.vadLastSpeechTs) <= this.vadConfig.speechHoldMs
        );

        let shouldSend = audioSpeech || holdActive;
        if (!shouldSend && this.vadSilenceAccumMs < this.vadConfig.silenceHoldMs) {
            shouldSend = true;
        }

        this.vadFillerSuppressed = this.vadConfig.fillerHoldMs > 0
            && this.vadSilenceAccumMs >= this.vadConfig.fillerHoldMs;

        return {
            shouldSend,
            audioSpeech,
            holdActive,
            speechRatio: stats.speechRatio,
            frameCount: stats.frameCount,
            speechFrames: stats.speechFrames,
            silenceAccumMs: this.vadSilenceAccumMs
        };
    }

    startSilenceFiller() {
        if (this.silenceInterval || this.silenceFillMs <= 0) {
            return;
        }
        const tick = Math.max(25, Math.floor(this.silenceFrameMs / 2));
        if (!this.lastSendTs) {
            this.lastSendTs = Date.now();
        }
        this.silenceInterval = setInterval(() => {
            if (this.terminated || this.reconnecting) {
                return;
            }
            if (typeof this.client.isReady === 'function' && !this.client.isReady()) {
                return;
            }
            if (this.flushAccumulatedAudio({ force: true })) {
                return;
            }
            const now = Date.now();
            if (this.silenceSuppressedUntil && now < this.silenceSuppressedUntil) {
                return;
            }
            const lastSend = this.lastSendTs || this.lastChunkReceivedAt || now;
            if ((now - lastSend) < this.silenceFillMs) {
                return;
            }
            if (this.vadConfig?.enabled && this.vadFillerSuppressed) {
                return;
            }
            const buffer = this.buildSilenceFrame();
            const sent = this.client.sendAudio(buffer, {
                filler: true,
                captureTs: now,
                sequence: this.lastSequence,
                silenceFrameMs: this.silenceFrameMs
            });
            if (!sent) {
                this.silenceFailureCount += 1;
                if (this.silenceFailureCount >= this.maxSilenceFailures) {
                    this.silenceSuppressedUntil = now + this.silenceBackoffMs;
                    this.silenceFailureCount = 0;
                    const warning = {
                        code: 'silence-disabled',
                        message: `Silence filler paused for ${this.silenceBackoffMs}ms due to repeated send failures`
                    };
                    log('warn', `Session ${this.id} ${warning.message}`);
                    this.emit('warning', warning);
                }
            } else {
                this.silenceFailureCount = 0;
            }
        }, tick);
    }

    stopSilenceFiller() {
        if (this.silenceInterval) {
            clearInterval(this.silenceInterval);
            this.silenceInterval = null;
        }
    }

    buildSilenceFrame() {
        const samples = Math.max(1, Math.floor(16000 * (this.silenceFrameMs / 1000)));
        const bytes = samples * 2; // 16-bit mono
        if (!this.silenceFrameBuffer || this.silenceFrameBuffer.length !== bytes) {
            this.silenceFrameBuffer = Buffer.alloc(bytes, 0);
        }
        return this.silenceFrameBuffer;
    }

    startHeartbeat() {
        if (this.heartbeatInterval) {
            return;
        }
        this.heartbeatInterval = setInterval(() => {
            if (this.terminated) {
                return;
            }
            this.emitHeartbeat();
        }, this.heartbeatIntervalMs);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    emitHeartbeat(stateOverride) {
        const now = Date.now();
        const state = stateOverride
            || (this.reconnecting ? 'reconnecting' : (this.silenceDurationMs >= this.silenceNotifyMs ? 'silence' : 'speech'));
        this.emit('heartbeat', {
            sessionId: this.id,
            sourceName: this.sourceName,
            state,
            silent: state === 'silence',
            reconnecting: state === 'reconnecting' || this.reconnecting,
            silenceDurationMs: this.silenceDurationMs,
            lastSpeechAt: this.lastSpeechAt || null,
            lastTranscriptAt: this.lastServerUpdateAt || null,
            timestamp: now,
            pcmRms: this.latestPcmStats?.rms ?? null,
            pcmPeak: this.latestPcmStats?.peak ?? null,
            vadSpeechRatio: this.latestVadStats?.speechRatio ?? null,
            vadFrames: this.latestVadStats?.frameCount ?? null
        });
    }

    scheduleReconnect() {
        if (this.reconnecting || this.terminated) {
            return;
        }
        this.reconnecting = true;
        this.reconnectAttempt = 0;
        const attemptReconnect = async () => {
            while (!this.terminated) {
                this.reconnectAttempt += 1;
                const attempt = this.reconnectAttempt;
                const delay = Math.min(5000, this.reconnectBackoffMs * Math.max(0, attempt - 1));
                if (delay > 0) {
                    await sleep(delay);
                }
                try {
                    await this.client.connect();
                    this.reconnecting = false;
                    this.reconnectAttempt = 0;
                    this.lastSendTs = Date.now();
                    this.emitHeartbeat('reconnected');
                    log('info', `Session ${this.id} reconnected after ${attempt} attempt(s)`);
                    return;
                } catch (error) {
                    log('warn', `Session ${this.id} reconnect attempt ${attempt} failed: ${error.message}`);
                    if (attempt >= this.maxReconnectAttempts) {
                        throw error;
                    }
                }
            }
        };

        this.reconnectPromise = attemptReconnect()
            .catch((error) => {
                if (this.terminated) {
                    return;
                }
                this.reconnecting = false;
                this.emit('error', new Error(`Realtime streaming client failed to reconnect: ${error.message}`));
            })
            .finally(() => {
                if (!this.terminated) {
                    this.reconnecting = false;
                }
                this.reconnectPromise = null;
            });
    }

    analyzePcmChunk(buffer) {
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
    }

    computeChunkDurationMs(buffer) {
        if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
            return 0;
        }
        const samples = Math.floor(buffer.length / 2);
        return Math.max(1, Math.round((samples / 16000) * 1000));
    }

    clearPendingFlushTimer() {
        if (this.pendingFlushTimer) {
            clearTimeout(this.pendingFlushTimer);
            this.pendingFlushTimer = null;
        }
    }

    schedulePendingFlush() {
        if (this.pendingFlushTimer || this.terminated) {
            return;
        }
        if (!Number.isFinite(this.maxPendingChunkMs) || this.maxPendingChunkMs <= 0) {
            return;
        }
        this.pendingFlushTimer = setTimeout(() => {
            this.pendingFlushTimer = null;
            if (this.terminated) {
                return;
            }
            this.flushAccumulatedAudio({ force: true });
        }, this.maxPendingChunkMs);
    }

    flushAccumulatedAudio(options = {}) {
        const { force = false, allowTerminated = false } = options;
        if (this.terminated && !allowTerminated) {
            return false;
        }
        if (!this.pcmBuffer || this.pcmBuffer.length === 0) {
            return false;
        }
        const chunkToSend = this.pcmBuffer;
        const metaToSend = this.firstChunkMeta;
        this.pcmBuffer = Buffer.alloc(0);
        this.firstChunkMeta = null;
        this.clearPendingFlushTimer();
        return this.processReadyChunk(chunkToSend, metaToSend, { force });
    }

    processReadyChunk(chunkToSend, metaToSend, options = {}) {
        const { force = false } = options;
        if (!chunkToSend || chunkToSend.length === 0) {
            return false;
        }

        const stats = this.analyzePcmChunk(chunkToSend);
        const chunkDurationMs = this.computeChunkDurationMs(chunkToSend);
        const wasSilent = this.silenceDurationMs >= this.silenceNotifyMs;
        this.latestPcmStats = { ...stats, durationMs: chunkDurationMs };
        const rmsSpeech = stats.rms >= this.silenceEnergyThreshold;

        let shouldSend = true;
        let treatAsSpeech = rmsSpeech;
        if (this.vadInstance && this.vadConfig.enabled) {
            const vadStats = this.evaluateVadDecision(chunkToSend, chunkDurationMs, rmsSpeech);
            this.latestVadStats = vadStats;
            shouldSend = vadStats.shouldSend;
            treatAsSpeech = vadStats.audioSpeech || vadStats.holdActive;
        } else {
            this.latestVadStats = null;
            this.vadFillerSuppressed = false;
            this.vadSilenceAccumMs = 0;
        }

        if (force) {
            shouldSend = true;
            treatAsSpeech = treatAsSpeech || rmsSpeech;
        }

        if (!treatAsSpeech) {
            this.silenceDurationMs = Math.min(this.silenceDurationMs + chunkDurationMs, 60_000);
            if (!wasSilent && this.silenceDurationMs >= this.silenceNotifyMs) {
                this.emitHeartbeat('silence');
            }
        } else {
            this.silenceDurationMs = 0;
            this.lastSpeechAt = Date.now();
            if (wasSilent) {
                this.emitHeartbeat('speech');
            }
        }

        if (!this.vadInstance && !treatAsSpeech && this.silenceDurationMs >= this.silenceSuppressMs && !force) {
            if (Math.random() < 0.02) {
                log('info', `Session ${this.id} suppressing ${chunkDurationMs}ms silent chunk (rms ${Math.round(stats.rms)})`);
            }
            return false;
        }

        if (!shouldSend && !force) {
            if (Math.random() < 0.02) {
                log('info', `Session ${this.id} VAD suppressed ${chunkDurationMs}ms chunk (rms ${Math.round(stats.rms)})`);
            }
            return false;
        }

        const conversionMs = (typeof metaToSend?.segmentProducedTs === 'number' && this.lastChunkReceivedAt)
            ? Math.max(0, metaToSend.segmentProducedTs - this.lastChunkReceivedAt)
            : undefined;

        if (typeof this.client.isReady === 'function' && !this.client.isReady()) {
            if (!this.reconnecting) {
                this.scheduleReconnect();
            }
            return false;
        }

        const sent = this.client.sendAudio(chunkToSend, metaToSend);
        if (!sent) {
            log('warn', `Session ${this.id} failed to enqueue PCM chunk (socket not ready)`);
            if (!this.reconnecting) {
                this.scheduleReconnect();
            }
            return false;
        }

        if (typeof conversionMs === 'number') {
            this.lastConversionMs = conversionMs;
            if (Math.random() < 0.05) {
                log('info', `Session ${this.id} conversion latency ~${conversionMs}ms`);
            }
        }

        return true;
    }
}

class StreamingTranscriptionService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.ffmpegPath = config?.ffmpegPath || null;
        this.sessions = new Map();
        this.ready = false;
    }

    async init() {
        const apiKey = this.config.providerConfig?.assembly?.apiKey;
        if (!apiKey) {
            throw new Error('ASSEMBLYAI_API_KEY must be configured.');
        }
        this.ready = true;
        const cfgTs = this.config.streaming?.chunkTimesliceMs;
        if (this.ffmpegPath) {
            log('info', `Streaming transcription service initialized (AssemblyAI realtime) - chunkTimesliceMs=${cfgTs ?? 'unset'} ffmpeg=${this.ffmpegPath}`);
        } else {
            log('warn', `Streaming transcription service initialized without explicit FFmpeg path - chunkTimesliceMs=${cfgTs ?? 'unset'} (falling back to system PATH)`);
        }
    }

    assertReady() {
        if (!this.ready) {
            throw new Error('Streaming transcription service is not initialized or disabled.');
        }
    }

    createClient() {
        if (this.config.streaming?.mock) {
            return new MockStreamingClient();
        }

        return new AssemblyLiveClient({
            apiKey: this.config.providerConfig?.assembly?.apiKey,
            streamingParams: this.config.streaming?.assemblyParams || {}
        });
    }

    async startSession(metadata = {}) {
        this.assertReady();
        const sessionId = metadata.sessionId || crypto.randomUUID();

        if (this.sessions.has(sessionId)) {
            throw new Error(`Session ${sessionId} already exists.`);
        }

        const client = this.createClient();
        const session = new LiveStreamingSession({
            sessionId,
            sourceName: metadata.sourceName || 'unknown-source',
            client,
            streamingConfig: this.config.streaming || {},
            ffmpegPath: metadata.ffmpegPath || this.ffmpegPath
        });

        session.on('update', (payload) => {
            const deltaSize = typeof payload.delta === 'string' ? payload.delta.length : 0;
            const latencyMs = typeof payload.latencyMs === 'number' ? payload.latencyMs : undefined;
            const pipelineMs = typeof payload.pipelineMs === 'number' ? payload.pipelineMs : undefined;
            log('info', `Session ${sessionId} update (${deltaSize} chars) ws:${latencyMs ?? '-'}ms e2e:${pipelineMs ?? '-'}ms`);
            this.emit('session-update', {
                sessionId,
                sourceName: session.sourceName,
                ...payload
            });
        });

        session.on('error', (error) => {
            log('error', `Session ${sessionId} error: ${error.message}`);
            this.emit('session-error', {
                sessionId,
                error: {
                    message: error?.message || 'Streaming transcription failed',
                    name: error?.name || 'Error'
                }
            });
        });

        session.on('warning', (payload = {}) => {
            log('warn', `Session ${sessionId} warning: ${payload.message || payload.code || 'unknown issue'}`);
            this.emit('session-warning', {
                sessionId,
                sourceName: session.sourceName,
                warning: payload
            });
        });

        session.on('heartbeat', (payload = {}) => {
            this.emit('session-heartbeat', {
                sessionId,
                sourceName: session.sourceName,
                ...payload
            });
        });

        this.sessions.set(sessionId, session);

        // Start the Live API connection
        try {
            await session.start();
            log('info', `Session ${sessionId} started for ${session.sourceName}`);
            this.emit('session-started', { sessionId, sourceName: session.sourceName });
        } catch (error) {
            this.sessions.delete(sessionId);
            throw error;
        }

        return sessionId;
    }

    pushChunk(sessionId, chunk) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }
        session.addChunk(chunk);
        return true;
    }

    async stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }
        await session.stop();
        this.sessions.delete(sessionId);
        log('info', `Session ${sessionId} stopped`);
        this.emit('session-stopped', { sessionId });
    }

    async stopAllSessions() {
        const pending = [];
        for (const sessionId of this.sessions.keys()) {
            pending.push(this.stopSession(sessionId));
        }
        await Promise.allSettled(pending);
        this.sessions.clear();
    }
}

module.exports = {
    StreamingTranscriptionService
};
