const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { GeminiLiveClient } = require('./live-client');
const { PersistentAudioConverter } = require('./audio-converter');

const LOG_PREFIX = '[Transcription:Streaming]';
const log = (level, message, ...args) => {
    const stamp = new Date().toISOString();
    const logger = console[level] || console.log;
    logger(`${LOG_PREFIX} ${stamp} ${message}`, ...args);
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
        this.silenceFillMs = Math.max(50, Number(this.streamingConfig.silenceFillMs) || 1000);
        this.silenceFrameMs = Math.min(500, Math.max(10, Number(this.streamingConfig.silenceFrameMs) || 100));
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
        this.firstChunkMeta = null;
        this.TARGET_CHUNK_SIZE = 3200; // Target chunk size: ~100ms of audio (16000Hz * 2 bytes * 0.1s = 3200 bytes)

        // Listen for transcription events from the Live API client
        this.client.on('transcription', (data) => {
            if (this.terminated) return;
            const absoluteText = typeof data.text === 'string' ? data.text : '';
            if (!absoluteText) {
                return;
            }

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
            } catch (err) {
                // ignore metric computation errors
            }
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

        this.client.on('disconnected', () => {
            if (!this.terminated) {
                log('warn', `Session ${this.id} disconnected unexpectedly`);
            }
        });
    }

    async start() {
        try {
            await this.client.connect();
            log('info', `Session ${this.id} Live API connected`);
            this.audioConverter = new PersistentAudioConverter({
                mimeType: this.inputMimeType,
                onData: (pcmChunk, info) => {
                    if (!this.terminated && pcmChunk.length > 0) {
                        try {
                            const producedAt = info?.producedAt;
                            if (this.pcmBuffer.length === 0) {
                                this.firstChunkMeta = this.buildChunkMeta(producedAt);
                            }

                            this.pcmBuffer = Buffer.concat([this.pcmBuffer, pcmChunk]);

                            if (this.pcmBuffer.length >= this.TARGET_CHUNK_SIZE) {
                                const chunkToSend = this.pcmBuffer;
                                const metaToSend = this.firstChunkMeta;

                                this.pcmBuffer = Buffer.alloc(0);
                                this.firstChunkMeta = null;

                                const conversionMs = (typeof metaToSend?.segmentProducedTs === 'number' && this.lastChunkReceivedAt)
                                    ? Math.max(0, metaToSend.segmentProducedTs - this.lastChunkReceivedAt)
                                    : undefined;

                                this.client.sendAudio(chunkToSend, metaToSend);

                                if (typeof conversionMs === 'number') {
                                    this.lastConversionMs = conversionMs;
                                    if (Math.random() < 0.05) {
                                        log('info', `Session ${this.id} conversion latency ~${conversionMs}ms`);
                                    }
                                }
                            }
                        } catch (err) {
                            log('error', `Session ${this.id} failed to send audio: ${err.message}`);
                        }
                    }
                },
                onError: (error) => {
                    log('error', `Session ${this.id} audio converter error: ${error.message}`);
                }
            });
            this.audioConverter.start();
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

        if (this.audioConverter) {
            this.audioConverter.stop();
            this.audioConverter = null;
        }

        // Flush any remaining audio in the buffer
        if (this.pcmBuffer && this.pcmBuffer.length > 0) {
            try {
                log('info', `Session ${this.id} flushing remaining ${this.pcmBuffer.length} bytes`);
                this.client.sendAudio(this.pcmBuffer, this.firstChunkMeta);
            } catch (err) {
                log('warn', `Session ${this.id} failed to flush audio: ${err.message}`);
            }
            this.pcmBuffer = Buffer.alloc(0);
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

    startSilenceFiller() {
        if (this.silenceInterval || this.silenceFillMs <= 0) {
            return;
        }
        const tick = Math.max(25, Math.floor(this.silenceFrameMs / 2));
        if (!this.lastSendTs) {
            this.lastSendTs = Date.now();
        }
        this.silenceInterval = setInterval(() => {
            if (this.terminated || !this.client.isReady()) {
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
}

class StreamingTranscriptionService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.sessions = new Map();
        this.ready = false;
    }

    async init() {
        const apiKey = this.config.providerConfig?.gemini?.apiKey;
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY must be configured.');
        }

        this.ready = true;
        const cfgTs = this.config.streaming?.chunkTimesliceMs;
        log('info', `Streaming transcription service initialized (Live API mode) - chunkTimesliceMs=${cfgTs ?? 'unset'}`);
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

        // Use Live API model - gemini-2.0-flash-live-001 or similar
        const model = this.config.providerConfig?.gemini?.model || 'gemini-2.0-flash-live-001';

        return new GeminiLiveClient({
            apiKey: this.config.providerConfig?.gemini?.apiKey,
            model: model,
            prompt: this.config.streaming.prompt
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
            streamingConfig: this.config.streaming || {}
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
