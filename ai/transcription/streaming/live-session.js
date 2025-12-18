const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PersistentAudioConverter } = require('./audio-converter');
const { createVadInstance } = require('./vad');
const { buildChunkMeta } = require('./packetizer');
const { buildSilenceFrame } = require('./silence-filler');
const {
    log,
    clampNumber,
    sleep,
    analyzePcmChunk,
    computeChunkDurationMs,
    computeLatencyBreakdown
} = require('./helpers');

/**
 * Live API Session using WebSocket connection with persistent audio conversion.
 * Uses a long-running ffmpeg process to convert WebM/Opus stream to PCM.
 */
class LiveStreamingSession extends EventEmitter {
    constructor(options) {
        super();
        this.id = options.sessionId;
        this.sourceName = options.sourceName;
        this.sourceType = options.sourceType || 'system';
        this.client = options.client;
        this.converterFactory = options.converterFactory || ((converterOptions) => new PersistentAudioConverter(converterOptions));
        this.terminated = false;
        this.lastSequence = -1;
        this.transcript = '';
        this.inputMimeType = 'audio/webm;codecs=opus';
        this.audioConverter = null;
        this.chunkInfo = new Map();
        this.streamingConfig = options.streamingConfig || {};
        this.ffmpegPath = options.ffmpegPath || null;
        const numOr = (value, fallback) => {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : fallback;
        };

        this.silenceFillMs = clampNumber(numOr(this.streamingConfig.silenceFillMs, 120), 50, 400);
        this.silenceFrameMs = clampNumber(numOr(this.streamingConfig.silenceFrameMs, 60), 30, 500);
        this.silenceInterval = null;
        this.lastSendTs = 0;
        this.lastChunkMeta = null;
        this.silenceFrameBuffer = null;
        this.lastServerTranscript = '';
        this.silenceFailureCount = 0;
        this.silenceSuppressedUntil = 0;
        this.maxSilenceFailures = Math.max(1, numOr(this.streamingConfig.silenceFailureThreshold, 5));
        this.silenceBackoffMs = Math.max(1000, numOr(this.streamingConfig.silenceBackoffMs, 10_000));
        this.pcmBuffer = Buffer.alloc(0);
        this.pendingFlushTimer = null;
        this.maxPendingChunkMs = clampNumber(numOr(this.streamingConfig.maxPendingChunkMs, 60), 30, 90);
        this.firstChunkMeta = null;
        this.TARGET_CHUNK_SIZE = 3200; // Target chunk size: ~100ms of audio (16000Hz * 2 bytes * 0.1s = 3200 bytes)
        this.heartbeatInterval = null;
        this.heartbeatIntervalMs = Math.max(100, numOr(this.streamingConfig.heartbeatIntervalMs, 250));
        this.silenceDurationMs = 0;
        this.silenceNotifyMs = Math.max(50, numOr(this.streamingConfig.silenceNotifyMs, 600));
        this.silenceSuppressMs = Math.max(this.silenceNotifyMs, numOr(this.streamingConfig.silenceSuppressMs, 900));
        this.silenceEnergyThreshold = Math.max(1, numOr(this.streamingConfig.silenceEnergyThreshold, 350));
        this.lastSpeechAt = Date.now();
        this.lastServerUpdateAt = 0;
        this.reconnecting = false;
        this.reconnectAttempt = 0;
        this.reconnectPromise = null;
        this.reconnectBackoffMs = Math.max(200, numOr(this.streamingConfig.reconnectBackoffMs, 750));
        this.maxReconnectAttempts = Math.max(1, numOr(this.streamingConfig.maxReconnectAttempts, 6));
        this.latestPcmStats = null;
        const vadCfg = this.streamingConfig.vad || {};
        this.vadConfig = {
            enabled: Boolean(vadCfg.enabled),
            frameMs: vadCfg.frameMs,
            aggressiveness: clampNumber(vadCfg.aggressiveness),
            minSpeechRatio: clampNumber(vadCfg.minSpeechRatio),
            speechHoldMs: Math.max(0, vadCfg.speechHoldMs),
            silenceHoldMs: Math.max(0, vadCfg.silenceHoldMs),
            fillerHoldMs: Math.max(0, vadCfg.fillerHoldMs)
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
            const isFinal = Boolean(
                data?.isFinal
                || data?.end_of_turn
                || data?.endOfTurn
                || data?.message_type === 'final_transcript'
                || data?.type === 'final_transcript'
            );
            const now = Date.now();
            this.lastServerUpdateAt = now;
            this.lastSpeechAt = now;
            this.silenceDurationMs = 0;

            const previousServer = this.lastServerTranscript;
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
                // Overlap handled below
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
                const breakdown = computeLatencyBreakdown(info);
                if (breakdown) {
                    log('info', `Session ${this.id} latency breakdown total:${breakdown.total}ms cap->ipc:${breakdown.captureToIpc ?? '-'}ms ipc->svc:${breakdown.ipcToService ?? '-'}ms svc->pcm:${breakdown.serviceToConverter ?? '-'}ms pcm->ws:${breakdown.converterToWs ?? '-'}ms ws->txt:${breakdown.wsToTranscript ?? '-'}ms`);
                }
            } catch (err) { }
            log('info', `Session ${this.id} update (${this.transcript.length} chars)`);
            this.emit('update', {
                text: absoluteText,
                delta,
                isFinal,
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
                            this.firstChunkMeta = buildChunkMeta(this.lastChunkMeta, this.lastSequence, producedAt);
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

            this.audioConverter = this.converterFactory(converterOptions);
            if (!this.audioConverter || typeof this.audioConverter.start !== 'function') {
                throw new Error('Audio converter is not properly configured.');
            }
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
            if (typeof this.audioConverter.stop === 'function') {
                this.audioConverter.stop();
            }
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

    async initializeVad() {
        if (this.vadInstance) {
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

        const stats = analyzePcmChunk(chunkToSend);
        const chunkDurationMs = computeChunkDurationMs(chunkToSend);
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

module.exports = {
    LiveStreamingSession
};
