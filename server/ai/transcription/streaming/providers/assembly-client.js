const { EventEmitter } = require('node:events');
const { StreamingTranscriber } = require('assemblyai');

const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
if (!fetchFn) {
    throw new Error('AssemblyLiveClient requires a global fetch implementation (Node 18+).');
}

const LOG_PREFIX = '[AssemblyLiveClient]';
const log = (level, message, ...args) => {
    const stamp = new Date().toISOString();
    const logger = console[level] || console.log;
    logger(`${LOG_PREFIX} ${stamp} ${message}`, ...args);
};

const DEFAULT_SAMPLE_RATE = 16000;
const REALTIME_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';
const DEFAULT_SPEECH_MODEL = 'universal-streaming-english';
const DEFAULT_ENCODING = 'pcm_s16le';

class AssemblyLiveClient extends EventEmitter {
    constructor(options = {}) {
        super();
        const {
            apiKey,
            sampleRate = DEFAULT_SAMPLE_RATE,
            streamingParams = {},
            enableRawMessages = false,
            speechModel = DEFAULT_SPEECH_MODEL,
            encoding = DEFAULT_ENCODING,
            tokenTtlSeconds = 60,
            maxSessionDurationSeconds
        } = options;

        if (!apiKey) {
            throw new Error('AssemblyLiveClient requires TRANSCRIPTION_API_KEY.');
        }

        this.apiKey = apiKey;
        this.sampleRate = sampleRate;
        this.streamingParams = streamingParams || {};
        this.speechModel = speechModel;
        this.encoding = encoding;
        this.tokenTtlSeconds = Math.max(30, Math.min(600, Number(tokenTtlSeconds) || 60));
        this.maxSessionDurationSeconds = typeof maxSessionDurationSeconds === 'number'
            ? Math.max(60, Math.min(3600, maxSessionDurationSeconds))
            : undefined;
        this.enableRawMessages = Boolean(enableRawMessages);

        this.transcriber = null;
        this.connectPromise = null;
        this.currentTermination = null;
        this.waitForTerminationOnClose = true;

        this.connected = false;
        this.ready = false;
        this.audioChunkCount = 0;
        this.lastSendTs = 0;
        this.sessionToken = null;
        this.sessionExpiresAt = null;
        this.sessionId = null;
    }

    buildTranscriberParams(token) {
        const params = {
            token,
            sampleRate: this.sampleRate
        };

        if (this.speechModel) {
            params.speechModel = this.speechModel;
        }
        if (this.encoding) {
            params.encoding = this.encoding;
        }

        const cfg = this.streamingParams || {};
        if (typeof cfg.endOfTurnConfidenceThreshold === 'number') {
            params.endOfTurnConfidenceThreshold = cfg.endOfTurnConfidenceThreshold;
        }
        if (typeof cfg.minEndOfTurnSilenceWhenConfident === 'number') {
            params.minEndOfTurnSilenceWhenConfident = cfg.minEndOfTurnSilenceWhenConfident;
        }
        if (typeof cfg.maxTurnSilence === 'number') {
            params.maxTurnSilence = cfg.maxTurnSilence;
        }
        if (typeof cfg.filterProfanity === 'boolean') {
            params.filterProfanity = cfg.filterProfanity;
        }
        if (typeof cfg.formatTurns === 'boolean') {
            params.formatTurns = cfg.formatTurns;
        }
        if (typeof cfg.languageDetection === 'boolean') {
            params.languageDetection = cfg.languageDetection;
        }
        if (typeof cfg.inactivityTimeout === 'number' && Number.isFinite(cfg.inactivityTimeout)) {
            params.inactivityTimeout = cfg.inactivityTimeout;
        }
        if (typeof cfg.vadThreshold === 'number' && Number.isFinite(cfg.vadThreshold)) {
            params.vadThreshold = cfg.vadThreshold;
        }
        if (Array.isArray(cfg.keytermsPrompt) && cfg.keytermsPrompt.length > 0) {
            params.keytermsPrompt = cfg.keytermsPrompt;
        } else if (Array.isArray(cfg.keyterms) && cfg.keyterms.length > 0) {
            params.keytermsPrompt = cfg.keyterms;
        }

        return params;
    }

    attachTranscriberEvents(transcriber) {
        transcriber.on('open', (event) => {
            if (this.enableRawMessages) {
                this.emit('raw-message', { type: 'Begin', ...event });
            }
            this.connected = true;
            this.ready = true;
            this.sessionId = event?.id || null;
            this.sessionExpiresAt = typeof event?.expires_at === 'number'
                ? new Date(event.expires_at * 1000)
                : null;
            log('info', `Streaming session opened (${this.sessionId || 'unknown'})`);
            this.emit('ready', {
                sessionId: this.sessionId,
                expiresAt: this.sessionExpiresAt
            });
        });

        transcriber.on('turn', (turn) => {
            if (this.enableRawMessages) {
                this.emit('raw-message', turn);
            }
            this.handleTurnEvent(turn);
        });

        transcriber.on('error', (error) => {
            log('error', `StreamingTranscriber error: ${error.message}`);
            this.emit('error', error);
        });

        transcriber.on('close', (code, reason) => {
            if (this.transcriber !== transcriber) {
                return;
            }
            const reasonText = typeof reason === 'string'
                ? reason
                : (reason && typeof reason.toString === 'function' ? reason.toString() : '');
            log('warn', `Streaming session closed (${code}) ${reasonText}`);
            this.cleanupConnectionState();
            this.emit('disconnected', { code, reason: reasonText });
        });
    }

    async connect() {
        if (this.isReady()) {
            return;
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }

        this.connectPromise = this.internalConnect();
        try {
            await this.connectPromise;
        } finally {
            this.connectPromise = null;
        }
    }

    async internalConnect() {
        await this.awaitTerminationIfNeeded();

        const token = await this.fetchRealtimeToken();
        this.sessionToken = token;
        const params = this.buildTranscriberParams(token);

        const transcriber = new StreamingTranscriber(params);
        this.transcriber = transcriber;
        this.attachTranscriberEvents(transcriber);

        log('info', 'Connecting to AssemblyAI realtime via SDK');
        try {
            const begin = await transcriber.connect();
            if (!this.ready) {
                this.connected = true;
                this.ready = true;
                this.sessionId = begin?.id || null;
                this.sessionExpiresAt = typeof begin?.expires_at === 'number'
                    ? new Date(begin.expires_at * 1000)
                    : null;
                this.emit('ready', {
                    sessionId: this.sessionId,
                    expiresAt: this.sessionExpiresAt
                });
            }
        } catch (error) {
            log('error', `Failed to establish AssemblyAI realtime session: ${error.message}`);
            try {
                await transcriber.close(false);
            } catch (closeError) {
                log('warn', `Error cleaning up failed connection: ${closeError.message}`);
            }
            if (this.transcriber === transcriber) {
                this.transcriber = null;
            }
            this.connected = false;
            this.ready = false;
            throw error;
        }
    }

    handleTurnEvent(turn) {
        if (!turn || typeof turn.transcript !== 'string') {
            return;
        }
        const text = turn.transcript.trimEnd();
        if (!text) {
            return;
        }
        const now = Date.now();
        const latencyMs = this.lastSendTs ? Math.max(0, now - this.lastSendTs) : undefined;
        const isFinal = Boolean(turn.end_of_turn);
        const payload = {
            text,
            type: isFinal ? 'final_transcript' : 'partial_transcript',
            latencyMs,
            confidence: typeof turn.end_of_turn_confidence === 'number'
                ? turn.end_of_turn_confidence
                : undefined
        };
        this.emit('transcription', payload);

        if (isFinal) {
            this.emit('turn-complete', {
                turnOrder: typeof turn.turn_order === 'number' ? turn.turn_order : undefined,
                transcript: text,
                confidence: payload.confidence
            });
        }
    }

    async fetchRealtimeToken() {
        const tokenParams = new URLSearchParams({
            expires_in_seconds: String(this.tokenTtlSeconds)
        });
        if (this.maxSessionDurationSeconds) {
            tokenParams.set('max_session_duration_seconds', String(this.maxSessionDurationSeconds));
        }
        if (this.speechModel) {
            tokenParams.set('speech_model', this.speechModel);
        }

        const url = `${REALTIME_TOKEN_URL}?${tokenParams.toString()}`;
        const response = await fetchFn(url, {
            method: 'GET',
            headers: {
                authorization: this.apiKey
            }
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`AssemblyAI realtime token request failed (${response.status}): ${body}`);
        }

        const payload = await response.json();
        if (!payload?.token) {
            throw new Error('AssemblyAI realtime token response missing token.');
        }
        return payload.token;
    }

    sendAudio(pcmBuffer, meta = {}) {
        if (!this.isReady()) {
            return false;
        }
        if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
            return false;
        }

        const sendTs = Date.now();
        try {
            this.transcriber.sendAudio(pcmBuffer);
            this.audioChunkCount += 1;
            this.lastSendTs = sendTs;
            const instrumentationMeta = {
                sequence: typeof meta.sequence === 'number' ? meta.sequence : undefined,
                captureTs: meta.captureTs ?? meta.clientTs,
                segmentProducedTs: meta.segmentProducedTs,
                filler: Boolean(meta.filler),
                wsSendTs: sendTs,
                pcmBytes: pcmBuffer.length
            };
            this.emit('chunk-sent', instrumentationMeta);
            return true;
        } catch (error) {
            log('error', `Failed to send realtime audio: ${error.message}`);
            this.emit('error', error);
            return false;
        }
    }

    sendAudioStreamEnd() {
        this.waitForTerminationOnClose = true;
    }

    sendKeepalive() {
        return this.isReady();
    }

    isReady() {
        return Boolean(this.transcriber && this.connected && this.ready);
    }

    async disconnect() {
        await this.awaitTerminationIfNeeded();
        if (!this.transcriber) {
            return;
        }
        const transcriber = this.transcriber;
        const waitForTermination = this.waitForTerminationOnClose !== false;
        this.waitForTerminationOnClose = true;

        try {
            const closePromise = transcriber.close(waitForTermination);
            this.currentTermination = closePromise;
            await closePromise;
        } finally {
            if (this.transcriber === transcriber) {
                this.cleanupConnectionState();
            }
            this.currentTermination = null;
        }
    }

    async awaitTerminationIfNeeded() {
        if (!this.currentTermination) {
            return;
        }
        try {
            await this.currentTermination;
        } catch (error) {
            log('warn', `Termination wait failed: ${error.message}`);
        } finally {
            this.currentTermination = null;
        }
    }

    cleanupConnectionState() {
        this.transcriber = null;
        this.connected = false;
        this.ready = false;
        this.audioChunkCount = 0;
        this.lastSendTs = 0;
        this.sessionToken = null;
        this.sessionExpiresAt = null;
        this.sessionId = null;
        this.waitForTerminationOnClose = true;
    }
}

module.exports = {
    AssemblyLiveClient
};
