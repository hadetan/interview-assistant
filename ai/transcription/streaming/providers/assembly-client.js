const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

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
const DEFAULT_BASE_URL = 'wss://streaming.assemblyai.com/v3/ws';
const REALTIME_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';
const DEFAULT_SPEECH_MODEL = 'universal-streaming-english';
const DEFAULT_ENCODING = 'pcm_s16le';
const TERMINATE_MESSAGE = JSON.stringify({ type: 'Terminate' });

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
            throw new Error('AssemblyLiveClient requires ASSEMBLYAI_API_KEY.');
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
        this.enableRawMessages = enableRawMessages;

        this.ws = null;
        this.connected = false;
        this.ready = false;
        this.lastSendTs = 0;
        this.audioChunkCount = 0;
        this.sessionToken = null;
        this.sessionExpiresAt = null;
    }

    buildUrl(token) {
        const query = new URLSearchParams({
            sample_rate: String(this.sampleRate),
            token
        });
        if (this.speechModel) {
            query.set('speech_model', this.speechModel);
        }
        if (this.encoding) {
            query.set('encoding', this.encoding);
        }
        if (typeof this.streamingParams.endOfTurnConfidenceThreshold === 'number') {
            query.set('end_of_turn_confidence_threshold', String(this.streamingParams.endOfTurnConfidenceThreshold));
        }
        if (typeof this.streamingParams.minEndOfTurnSilenceWhenConfident === 'number') {
            query.set('min_end_of_turn_silence_when_confident', String(this.streamingParams.minEndOfTurnSilenceWhenConfident));
        }
        if (typeof this.streamingParams.maxTurnSilence === 'number') {
            query.set('max_turn_silence', String(this.streamingParams.maxTurnSilence));
        }
        if (typeof this.streamingParams.formatTurns === 'boolean') {
            query.set('format_turns', String(this.streamingParams.formatTurns));
        }
        if (typeof this.streamingParams.filterProfanity === 'boolean') {
            query.set('filter_profanity', String(this.streamingParams.filterProfanity));
        }
        if (Array.isArray(this.streamingParams.keytermsPrompt) && this.streamingParams.keytermsPrompt.length > 0) {
            query.set('keyterms_prompt', JSON.stringify(this.streamingParams.keytermsPrompt));
        }
        return `${DEFAULT_BASE_URL}?${query.toString()}`;
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

    async connect() {
        if (this.ws && this.connected) {
            return;
        }

        this.sessionToken = await this.fetchRealtimeToken();
        const url = this.buildUrl(this.sessionToken);
        log('info', 'Connecting to AssemblyAI universal streaming endpoint');

        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('AssemblyAI realtime connection timed out.'));
            }, 15000);

            this.ws = new WebSocket(url);
            this.ws.binaryType = 'arraybuffer';

            this.ws.on('open', () => {
                log('info', 'Streaming socket opened');
                this.connected = true;
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data);
                if (this.ready && !settled) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve();
                }
            });

            this.ws.on('error', (error) => {
                log('error', `Realtime socket error: ${error.message}`);
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject(error);
                } else {
                    this.emit('error', error);
                }
            });

            this.ws.on('close', (code, reason) => {
                log('warn', `Realtime socket closed ${code} ${reason || ''}`);
                this.connected = false;
                this.ready = false;
                this.emit('disconnected', { code, reason: reason?.toString() });
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject(new Error(`AssemblyAI streaming closed before session began (${code})`));
                }
            });
        });
    }

    sendRealtimeConfig() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        const payload = this.buildUpdateConfiguration();
        if (!payload) {
            return;
        }
        try {
            this.ws.send(JSON.stringify(payload));
        } catch (error) {
            log('error', `Failed to send configuration update: ${error.message}`);
        }
    }

    buildUpdateConfiguration() {
        const updates = {};
        if (typeof this.streamingParams.endOfTurnConfidenceThreshold === 'number') {
            updates.end_of_turn_confidence_threshold = this.streamingParams.endOfTurnConfidenceThreshold;
        }
        if (typeof this.streamingParams.minEndOfTurnSilenceWhenConfident === 'number') {
            updates.min_end_of_turn_silence_when_confident = this.streamingParams.minEndOfTurnSilenceWhenConfident;
        }
        if (typeof this.streamingParams.maxTurnSilence === 'number') {
            updates.max_turn_silence = this.streamingParams.maxTurnSilence;
        }
        if (Object.keys(updates).length === 0) {
            return null;
        }
        return {
            type: 'UpdateConfiguration',
            ...updates
        };
    }

    handleMessage(data) {
        if (!data) {
            return;
        }

        let message;
        try {
            if (typeof data === 'string') {
                message = JSON.parse(data);
            } else if (Buffer.isBuffer(data)) {
                message = JSON.parse(data.toString('utf8'));
            } else {
                message = JSON.parse(Buffer.from(data).toString('utf8'));
            }
        } catch (error) {
            log('warn', `Unable to parse realtime payload: ${error.message}`);
            return;
        }

        if (this.enableRawMessages) {
            this.emit('raw-message', message);
        }

        if (typeof message?.error === 'string') {
            const error = new Error(message.error);
            this.emit('error', error);
            return;
        }

        const type = message.message_type || message.type;
        switch (type) {
            case 'Begin': {
                this.ready = true;
                this.sessionExpiresAt = message.expires_at ? new Date(message.expires_at * 1000) : null;
                this.sendRealtimeConfig();
                this.emit('ready', {
                    sessionId: message.id,
                    expiresAt: this.sessionExpiresAt
                });
                return;
            }
            case 'Turn': {
                const text = message.transcript || '';
                if (!text) {
                    return;
                }
                const now = Date.now();
                const latencyMs = this.lastSendTs ? Math.max(0, now - this.lastSendTs) : undefined;
                this.emit('transcription', {
                    text,
                    type: message.end_of_turn ? 'final_transcript' : 'partial_transcript',
                    latencyMs,
                    confidence: message.end_of_turn_confidence
                });
                if (message.end_of_turn) {
                    this.emit('turn-complete', {
                        turnOrder: message.turn_order,
                        transcript: text
                    });
                }
                return;
            }
            case 'Termination':
                log('info', 'AssemblyAI session terminated by server');
                this.ready = false;
                return;
            default:
                return;
        }
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
            this.ws.send(pcmBuffer);
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
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            this.ws.send(TERMINATE_MESSAGE);
        } catch (error) {
            log('warn', `Failed to send terminate message: ${error.message}`);
        }
    }

    sendKeepalive() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            if (typeof this.ws.ping === 'function') {
                this.ws.ping();
            } else {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
            return true;
        } catch (error) {
            log('warn', `Failed to send websocket keepalive: ${error.message}`);
            return false;
        }
    }

    isReady() {
        return Boolean(this.ws && this.connected && this.ready && this.ws.readyState === WebSocket.OPEN);
    }

    disconnect() {
        if (!this.ws) {
            return;
        }
        try {
            this.sendAudioStreamEnd();
            this.ws.close(1000, 'client_disconnect');
        } catch (error) {
            log('warn', `Error closing realtime socket: ${error.message}`);
        } finally {
            this.ws = null;
            this.connected = false;
            this.ready = false;
        }
    }
}

module.exports = {
    AssemblyLiveClient
};
