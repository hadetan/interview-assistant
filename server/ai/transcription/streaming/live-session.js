const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PersistentAudioConverter } = require('./audio-converter');
const { createVadInstance } = require('./vad');
const { buildChunkMeta } = require('./packetizer');
const {
    log,
    clampNumber,
    sleep,
    analyzePcmChunk,
    computeChunkDurationMs,
    computeLatencyBreakdown
} = require('./helpers');

const PCM_SAMPLE_RATE = 16000;
const PCM_BYTES_PER_SAMPLE = 2;

/**
 * Live API Session using WebSocket connection with persistent audio conversion.
 * Uses a long-running ffmpeg process to convert WebM/Opus stream to PCM.
 */
class LiveStreamingSession extends EventEmitter {
    constructor(options) {
        super();
        this.id = options.sessionId;
        this.sourceName = options.sourceName;
        this.sourceType = options.sourceType;
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

        this.lastSendTs = 0;
        this.lastChunkMeta = null;
        this.lastServerTranscript = '';
        this.pcmBuffer = Buffer.alloc(0);
        this.pendingFlushTimer = null;
        this.maxPendingChunkMs = clampNumber(numOr(this.streamingConfig.maxPendingChunkMs, 60), 20, 120);
        this.firstChunkMeta = null;

        const minSamples = Math.round(PCM_SAMPLE_RATE * 0.02); // 20ms floor
        const configuredChunkBytes = numOr(this.streamingConfig.targetPcmChunkBytes, NaN);
        const targetChunkMs = clampNumber(numOr(this.streamingConfig.targetPcmChunkMs, 60), 20, 160);

        let targetSamples;
        if (Number.isFinite(configuredChunkBytes) && configuredChunkBytes > 0) {
            const configuredSamples = Math.round(configuredChunkBytes / PCM_BYTES_PER_SAMPLE);
            targetSamples = Math.max(minSamples, configuredSamples);
            this.targetChunkDurationMs = Math.max(1, Math.round((targetSamples / PCM_SAMPLE_RATE) * 1000));
        } else {
            targetSamples = Math.max(minSamples, Math.round((targetChunkMs / 1000) * PCM_SAMPLE_RATE));
            this.targetChunkDurationMs = targetChunkMs;
        }

        this.targetChunkBytes = targetSamples * PCM_BYTES_PER_SAMPLE;
        this.TARGET_CHUNK_SIZE = this.targetChunkBytes;
        this.chunkPartCounter = 0;
        this.suppressedSilenceMs = 0;
        this.lastFillerSentAt = 0;
        this.silenceFillerIntervalMs = clampNumber(numOr(this.streamingConfig.silenceFillerIntervalMs, 240), 100, 1500);
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
        const vadEnabled = vadCfg.enabled !== undefined ? Boolean(vadCfg.enabled) : true;
        const vadFrameMs = numOr(vadCfg.frameMs, 30);
        const vadAggressiveness = clampNumber(numOr(vadCfg.aggressiveness, 2), 0, 3);
        const vadMinSpeechRatio = clampNumber(numOr(vadCfg.minSpeechRatio, 0.2), 0.01, 1);
        const vadSpeechHoldMs = Math.max(0, numOr(vadCfg.speechHoldMs, 300));
        const vadSilenceHoldMs = Math.max(0, numOr(vadCfg.silenceHoldMs, 200));
        this.vadConfig = {
            enabled: vadEnabled,
            frameMs: vadFrameMs,
            aggressiveness: vadAggressiveness,
            minSpeechRatio: vadMinSpeechRatio,
            speechHoldMs: vadSpeechHoldMs,
            silenceHoldMs: vadSilenceHoldMs
        };
        this.vadInstance = null;
        this.vadLastSpeechTs = 0;
        this.vadSilenceAccumMs = 0;
        this.latestVadStats = null;
        this.metrics = {
            vadSuppressedChunks: 0,
            vadSentChunks: 0,
            vadHoldActivations: 0
        };
        this.socketKeepaliveMs = Math.max(0, numOr(this.streamingConfig.socketKeepaliveMs, 0));
        this.socketKeepaliveInterval = null;
        this.maxQueuedKeepaliveWarns = 5;
        this.keepaliveWarns = 0;

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
            log('info', `Session ${this.id} PCM target ~${this.targetChunkDurationMs}ms (${this.targetChunkBytes} bytes)`);
            this.startHeartbeat();
            this.startSocketKeepalive();

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
        this.stopSocketKeepalive();
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

        try {
            await this.client.disconnect();
        } catch (error) {
            log('warn', `Session ${this.id} disconnect error: ${error.message}`);
        }
    }

    async initializeVad() {
        if (!this.vadConfig.enabled) {
            this.vadInstance = null;
            log('info', `Session ${this.id} VAD disabled by configuration`);
            return;
        }
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

    recordVadMetrics(vadStats, pcmStats, chunkDurationMs) {
        if (!vadStats) {
            return;
        }
        if (vadStats.holdActive) {
            this.metrics.vadHoldActivations += 1;
        }
        if (vadStats.shouldSend) {
            this.metrics.vadSentChunks += 1;
            if (this.metrics.vadSentChunks <= 5 || (this.metrics.vadSentChunks % 50) === 0) {
                log('debug', `Session ${this.id} VAD sent ${chunkDurationMs}ms chunk (speechRatio ${vadStats.speechRatio?.toFixed?.(2) ?? 'n/a'}, rms ${Math.round(pcmStats.rms)})`);
            }
            return;
        }

        this.metrics.vadSuppressedChunks += 1;
        if (this.metrics.vadSuppressedChunks <= 5 || (this.metrics.vadSuppressedChunks % 50) === 0) {
            log('debug', `Session ${this.id} VAD suppressed ${chunkDurationMs}ms chunk (speechRatio ${vadStats.speechRatio?.toFixed?.(2) ?? 'n/a'}, rms ${Math.round(pcmStats.rms)})`);
        }
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

    startSocketKeepalive() {
        if (this.socketKeepaliveInterval || this.socketKeepaliveMs <= 0) {
            return;
        }
        if (typeof this.client.sendKeepalive !== 'function' && typeof this.client.ping !== 'function') {
            if (this.keepaliveWarns < this.maxQueuedKeepaliveWarns) {
                log('debug', `Session ${this.id} keepalive disabled: client does not expose keepalive interface`);
                this.keepaliveWarns += 1;
            }
            return;
        }
        this.socketKeepaliveInterval = setInterval(() => {
            if (this.terminated || this.reconnecting) {
                return;
            }
            try {
                if (typeof this.client.sendKeepalive === 'function') {
                    this.client.sendKeepalive();
                } else {
                    this.client.ping();
                }
            } catch (error) {
                if (this.keepaliveWarns < this.maxQueuedKeepaliveWarns) {
                    log('debug', `Session ${this.id} keepalive error: ${error.message}`);
                    this.keepaliveWarns += 1;
                }
            }
        }, this.socketKeepaliveMs);
    }

    stopSocketKeepalive() {
        if (this.socketKeepaliveInterval) {
            clearInterval(this.socketKeepaliveInterval);
            this.socketKeepaliveInterval = null;
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
            vadFrames: this.latestVadStats?.frameCount ?? null,
            vadSuppressedChunks: this.metrics.vadSuppressedChunks,
            vadSentChunks: this.metrics.vadSentChunks,
            vadHoldActivations: this.metrics.vadHoldActivations
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

        this.clearPendingFlushTimer();

        const shouldForce = Boolean(force);
        const targetBytes = Math.max(this.targetChunkBytes || this.TARGET_CHUNK_SIZE || 3200, PCM_BYTES_PER_SAMPLE * Math.round(PCM_SAMPLE_RATE * 0.02));
        const workingBuffer = this.pcmBuffer;
        const baseMeta = this.firstChunkMeta;

        let offsetBytes = 0;
        let elapsedMs = 0;
        let partIndex = 0;
        let sentAny = false;

        const sendSlice = (sliceBuffer, sliceMeta) => {
            const ok = this.processReadyChunk(sliceBuffer, sliceMeta, { force: shouldForce });
            if (ok) {
                sentAny = true;
            }
        };

        while ((workingBuffer.length - offsetBytes) >= targetBytes) {
            const slice = workingBuffer.subarray(offsetBytes, offsetBytes + targetBytes);
            const durationMs = computeChunkDurationMs(slice);
            const metaForSlice = this.decorateChunkMeta(baseMeta, {
                partIndex,
                offsetMs: elapsedMs,
                chunkBytes: slice.length,
                chunkDurationMs: durationMs
            });
            sendSlice(slice, metaForSlice);
            offsetBytes += targetBytes;
            elapsedMs += durationMs;
            partIndex += 1;
        }

        const remainingBytes = workingBuffer.length - offsetBytes;
        if (remainingBytes > 0) {
            const remainder = workingBuffer.subarray(offsetBytes);
            if (shouldForce) {
                const durationMs = computeChunkDurationMs(remainder);
                const metaForSlice = this.decorateChunkMeta(baseMeta, {
                    partIndex,
                    offsetMs: elapsedMs,
                    chunkBytes: remainder.length,
                    chunkDurationMs: durationMs
                });
                sendSlice(remainder, metaForSlice);
                offsetBytes += remainingBytes;
            } else {
                this.pcmBuffer = Buffer.from(remainder);
                this.firstChunkMeta = this.buildPendingMeta(baseMeta, elapsedMs);
                this.schedulePendingFlush();
                return sentAny;
            }
        }

        this.pcmBuffer = Buffer.alloc(0);
        this.firstChunkMeta = null;
        return sentAny;
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
            this.recordVadMetrics(vadStats, stats, chunkDurationMs);
            shouldSend = vadStats.shouldSend;
            treatAsSpeech = vadStats.audioSpeech || vadStats.holdActive;
        } else {
            this.latestVadStats = null;
            this.vadSilenceAccumMs = 0;
        }

        if (force) {
            shouldSend = true;
            treatAsSpeech = treatAsSpeech || rmsSpeech;
        }

        if (!treatAsSpeech) {
            this.silenceDurationMs = Math.min(this.silenceDurationMs + chunkDurationMs, 60_000);
            this.suppressedSilenceMs = Math.min(60_000, this.suppressedSilenceMs + chunkDurationMs);
            if (!wasSilent && this.silenceDurationMs >= this.silenceNotifyMs) {
                this.emitHeartbeat('silence');
            }
        } else {
            this.silenceDurationMs = 0;
            this.lastSpeechAt = Date.now();
            this.suppressedSilenceMs = 0;
            if (wasSilent) {
                this.emitHeartbeat('speech');
            }
        }

        if (!this.vadInstance && !treatAsSpeech && this.silenceDurationMs >= this.silenceSuppressMs && !force) {
            this.maybeSendSilenceFiller(metaToSend, chunkDurationMs);
            if (Math.random() < 0.02) {
                log('info', `Session ${this.id} suppressing ${chunkDurationMs}ms silent chunk (rms ${Math.round(stats.rms)})`);
            }
            return false;
        }

        if (!shouldSend && !force) {
            this.maybeSendSilenceFiller(metaToSend, chunkDurationMs);
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

        this.suppressedSilenceMs = 0;
        this.lastFillerSentAt = Date.now();

        if (typeof conversionMs === 'number') {
            this.lastConversionMs = conversionMs;
            if (Math.random() < 0.05) {
                log('info', `Session ${this.id} conversion latency ~${conversionMs}ms`);
            }
        }

        return true;
    }

    maybeSendSilenceFiller(baseMeta, chunkDurationMs) {
        if (this.silenceFillerIntervalMs <= 0) {
            return;
        }
        const now = Date.now();
        if (this.suppressedSilenceMs < this.silenceFillerIntervalMs) {
            return;
        }
        if ((now - this.lastFillerSentAt) < this.silenceFillerIntervalMs) {
            return;
        }

        const minSamples = Math.max(Math.round(PCM_SAMPLE_RATE * 0.02), 1);
        const targetSamples = Math.max(minSamples, Math.round((this.targetChunkBytes || this.TARGET_CHUNK_SIZE || minSamples * PCM_BYTES_PER_SAMPLE) / PCM_BYTES_PER_SAMPLE));
        const fillerBuffer = Buffer.alloc(targetSamples * PCM_BYTES_PER_SAMPLE);
        const fillerDurationMs = computeChunkDurationMs(fillerBuffer);
        let fillerMeta = this.decorateChunkMeta(baseMeta, {
            partIndex: 0,
            offsetMs: 0,
            chunkBytes: fillerBuffer.length,
            chunkDurationMs: fillerDurationMs
        }) || {};
        if (!baseMeta) {
            fillerMeta.sequence = (this.lastChunkMeta?.sequence ?? -1) + 0.001;
            fillerMeta.chunkPartId = this.chunkPartCounter;
            this.chunkPartCounter += 1;
        }
        fillerMeta.filler = true;
        fillerMeta.silenceMs = this.suppressedSilenceMs;

        if (typeof this.client.isReady === 'function' && !this.client.isReady()) {
            return;
        }

        const sent = this.client.sendAudio(fillerBuffer, fillerMeta);
        if (sent) {
            this.lastFillerSentAt = now;
            this.suppressedSilenceMs = 0;
            if (Math.random() < 0.08) {
                log('debug', `Session ${this.id} sent ${fillerDurationMs}ms silence filler`);
            }
        }
    }

    decorateChunkMeta(baseMeta, details = {}) {
        if (!baseMeta) {
            return undefined;
        }
        const meta = { ...baseMeta };
        const {
            partIndex = 0,
            offsetMs = 0,
            chunkBytes = 0,
            chunkDurationMs = null
        } = details;

        if (typeof baseMeta.segmentProducedTs === 'number') {
            meta.segmentProducedTs = baseMeta.segmentProducedTs + offsetMs;
        }
        meta.sequencePart = partIndex;
        meta.chunkPartId = this.chunkPartCounter;
        meta.chunkBytes = chunkBytes;
        meta.chunkDurationMs = chunkDurationMs;
        meta.chunkOffsetMs = offsetMs;
        this.chunkPartCounter += 1;
        return meta;
    }

    buildPendingMeta(baseMeta, offsetMs) {
        if (!baseMeta) {
            return null;
        }
        const meta = { ...baseMeta };
        if (typeof baseMeta.segmentProducedTs === 'number') {
            meta.segmentProducedTs = baseMeta.segmentProducedTs + offsetMs;
        }
        delete meta.sequencePart;
        delete meta.chunkPartId;
        delete meta.chunkBytes;
        delete meta.chunkDurationMs;
        delete meta.chunkOffsetMs;
        return meta;
    }
}

module.exports = {
    LiveStreamingSession
};
