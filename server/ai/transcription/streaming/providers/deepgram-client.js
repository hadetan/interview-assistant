const { EventEmitter } = require('node:events');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const LOG_PREFIX = '[DeepgramLiveClient]';
const log = (level, message, ...args) => {
    const logger = console[level] || console.log;
    logger(`${LOG_PREFIX} ${new Date().toISOString()} ${message}`, ...args);
};

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_ENCODING = 'linear16';
const DEFAULT_CHANNELS = 1;
const DEFAULT_MODEL = 'nova-3';

class DeepgramLiveClient extends EventEmitter {
    constructor(options = {}) {
        super();
        const {
            apiKey,
            sampleRate = DEFAULT_SAMPLE_RATE,
            encoding = DEFAULT_ENCODING,
            channels = DEFAULT_CHANNELS,
            liveOptions = {},
            clientOptions = {},
            clientFactory = createClient,
            enableRawMessages = false
        } = options;

        if (!apiKey) {
            throw new Error('DeepgramLiveClient requires TRANSCRIPTION_API_KEY.');
        }

        this.apiKey = apiKey;
        const resolvedSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE;
        const resolvedChannels = Number.isFinite(channels) && channels > 0 ? channels : DEFAULT_CHANNELS;
        const resolvedEncoding = typeof encoding === 'string' && encoding ? encoding : DEFAULT_ENCODING;

        this.liveOptions = {
            model: DEFAULT_MODEL,
            encoding: resolvedEncoding,
            sample_rate: resolvedSampleRate,
            channels: resolvedChannels,
            smart_format: true,
            interim_results: true,
            punctuate: true,
            ...liveOptions
        };

        this.sampleRate = this.normalizeNumber(this.liveOptions, 'sample_rate', resolvedSampleRate);
        this.channels = this.normalizeNumber(this.liveOptions, 'channels', resolvedChannels);
        this.encoding = typeof this.liveOptions.encoding === 'string' && this.liveOptions.encoding
            ? this.liveOptions.encoding
            : resolvedEncoding;
        this.liveOptions.encoding = this.encoding;

        this.enableRawMessages = Boolean(enableRawMessages);
        this.clientOptions = clientOptions;
        this.clientFactory = typeof clientFactory === 'function' ? clientFactory : createClient;

        this.deepgramClient = null;
        this.connection = null;
        this.connectPromise = null;
        this.connected = false;
        this.ready = false;

        this.lastSendTs = 0;
        this.absoluteTranscript = '';
        this.totalTranscript = '';
    }

    normalizeNumber(target, key, fallback) {
        const value = target[key];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return value;
        }
        if (typeof value === 'string') {
            const parsed = Number(value.trim());
            if (Number.isFinite(parsed) && parsed > 0) {
                target[key] = parsed;
                return parsed;
            }
        }
        target[key] = fallback;
        return fallback;
    }

    async connect() {
        if (this.isReady()) {
            return;
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }

        this.connectPromise = new Promise((resolve, reject) => {
            let resolved = false;
            try {
                this.deepgramClient = this.clientFactory(this.apiKey, this.clientOptions);
                const connection = this.deepgramClient.listen.live(this.liveOptions);
                this.connection = connection;
                this.bindConnectionEvents(connection);

                const removeListener = (event, handler) => {
                    if (typeof connection.off === 'function') {
                        connection.off(event, handler);
                    } else if (typeof connection.removeListener === 'function') {
                        connection.removeListener(event, handler);
                    }
                };

                const handleOpen = () => {
                    removeListener(LiveTranscriptionEvents.Open, handleOpen);
                    removeListener(LiveTranscriptionEvents.Error, handleInitialError);
                    this.connected = true;
                    this.ready = true;
                    resolved = true;
                    log('info', 'Deepgram realtime session opened');
                    this.emit('ready', {});
                    resolve();
                };

                const handleInitialError = (error) => {
                    if (resolved) {
                        return;
                    }
                    removeListener(LiveTranscriptionEvents.Open, handleOpen);
                    removeListener(LiveTranscriptionEvents.Error, handleInitialError);
                    const err = this.extractError(error);
                    log('error', `Failed to establish Deepgram realtime session: ${err.message}`);
                    reject(err);
                };

                connection.once(LiveTranscriptionEvents.Open, handleOpen);
                connection.once(LiveTranscriptionEvents.Error, handleInitialError);
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });

        try {
            await this.connectPromise;
        } finally {
            this.connectPromise = null;
        }
    }

    bindConnectionEvents(connection) {
        if (typeof connection.removeAllListeners === 'function') {
            connection.removeAllListeners();
        }

        connection.on(LiveTranscriptionEvents.Metadata, (metadata) => {
            if (this.enableRawMessages) {
                this.emit('raw-message', metadata);
            }
            this.emit('metadata', metadata);
        });

        connection.on(LiveTranscriptionEvents.Transcript, (payload) => {
            if (this.enableRawMessages) {
                this.emit('raw-message', payload);
            }
            this.handleTranscriptEvent(payload);
        });

        connection.on(LiveTranscriptionEvents.UtteranceEnd, (payload) => {
            if (this.enableRawMessages) {
                this.emit('raw-message', payload);
            }
            this.emit('utterance-end', payload);
        });

        connection.on(LiveTranscriptionEvents.SpeechStarted, (payload) => {
            if (this.enableRawMessages) {
                this.emit('raw-message', payload);
            }
            this.emit('speech-started', payload);
        });

        connection.on(LiveTranscriptionEvents.Open, () => {
            this.connected = true;
            this.ready = true;
        });

        connection.on(LiveTranscriptionEvents.Error, (event) => {
            const err = this.extractError(event);
            if (!this.ready) {
                return;
            }
            log('error', `Deepgram realtime error: ${err.message}`);
            this.emit('error', err);
        });

        connection.on(LiveTranscriptionEvents.Close, (event = {}) => {
            log('warn', `Deepgram realtime session closed (${event.code ?? 'no-code'})`);
            this.cleanupConnectionState();
            this.emit('disconnected', {
                code: event.code,
                reason: event.reason
            });
        });
    }

    extractError(event) {
        if (!event) {
            return new Error('Deepgram realtime error.');
        }
        if (event instanceof Error) {
            return event;
        }
        if (event.error instanceof Error) {
            return event.error;
        }
        if (typeof event.message === 'string') {
            return new Error(event.message);
        }
        if (typeof event.toString === 'function') {
            return new Error(event.toString());
        }
        return new Error('Deepgram realtime error.');
    }

    handleTranscriptEvent(event) {
        const alternative = event?.channel?.alternatives?.[0];
        const absoluteText = typeof alternative?.transcript === 'string' ? alternative.transcript.trimEnd() : '';
        if (!absoluteText) {
            return;
        }

        const isFinal = Boolean(event?.is_final || event?.speech_final);
        const now = Date.now();
        const latencyMs = this.lastSendTs ? Math.max(0, now - this.lastSendTs) : undefined;
        const confidence = typeof alternative?.confidence === 'number' ? alternative.confidence : undefined;

        const previous = this.absoluteTranscript || '';
        if (absoluteText === previous && !isFinal) {
            return;
        }

        let delta = '';
        if (absoluteText.startsWith(previous)) {
            delta = absoluteText.slice(previous.length);
        } else {
            const maxOverlap = Math.min(previous.length, absoluteText.length);
            let overlap = 0;
            for (let k = maxOverlap; k > 0; k -= 1) {
                if (previous.slice(previous.length - k) === absoluteText.slice(0, k)) {
                    overlap = k;
                    break;
                }
            }
            delta = absoluteText.slice(overlap);
        }

        this.absoluteTranscript = absoluteText;
        this.totalTranscript = (this.totalTranscript || '') + delta;

        const payload = {
            text: absoluteText,
            delta,
            isFinal,
            type: isFinal ? 'final_transcript' : 'partial_transcript',
            latencyMs,
            confidence
        };

        this.emit('transcription', payload);

        if (isFinal) {
            this.emit('turn-complete', {
                transcript: absoluteText,
                confidence
            });
            this.absoluteTranscript = '';
        }
    }

    sendAudio(pcmBuffer, meta = {}) {
        if (!this.isReady()) {
            return false;
        }
        if (pcmBuffer == null) {
            return false;
        }

        let payload;
        if (Buffer.isBuffer(pcmBuffer)) {
            payload = pcmBuffer;
        } else if (pcmBuffer instanceof ArrayBuffer) {
            payload = Buffer.from(pcmBuffer);
        } else if (ArrayBuffer.isView(pcmBuffer)) {
            payload = Buffer.from(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
        } else {
            return false;
        }

        if (!payload.length) {
            return false;
        }

        const sendTs = Date.now();
        try {
            this.connection.send(payload);
            this.lastSendTs = sendTs;
            this.emit('chunk-sent', {
                sequence: typeof meta.sequence === 'number' ? meta.sequence : undefined,
                captureTs: meta.captureTs ?? meta.clientTs,
                segmentProducedTs: meta.segmentProducedTs,
                filler: Boolean(meta.filler),
                wsSendTs: sendTs,
                pcmBytes: payload.length
            });
            return true;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            log('error', `Failed to send Deepgram audio: ${err.message}`);
            this.emit('error', err);
            return false;
        }
    }

    sendKeepalive() {
        if (!this.isReady()) {
            return false;
        }
        if (this.connection && typeof this.connection.keepAlive === 'function') {
            this.connection.keepAlive();
            return true;
        }
        return false;
    }

    isReady() {
        if (!this.connection) {
            return false;
        }
        if (typeof this.connection.isConnected === 'function') {
            return this.connection.isConnected();
        }
        if (typeof this.connection.connectionState === 'function') {
            try {
                return String(this.connection.connectionState()).toLowerCase() === 'open';
            } catch (err) {
                return this.ready;
            }
        }
        return this.ready;
    }

    async disconnect() {
        if (this.connection) {
            try {
                if (typeof this.connection.requestClose === 'function') {
                    this.connection.requestClose();
                } else if (typeof this.connection.finalize === 'function') {
                    this.connection.finalize();
                }
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                log('warn', `Deepgram requestClose failed: ${err.message}`);
            }

            try {
                if (typeof this.connection.disconnect === 'function') {
                    this.connection.disconnect();
                } else if (typeof this.connection.close === 'function') {
                    this.connection.close();
                }
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                log('warn', `Deepgram disconnect failed: ${err.message}`);
            }
        }
        this.cleanupConnectionState();
    }

    cleanupConnectionState() {
        if (this.connection && typeof this.connection.removeAllListeners === 'function') {
            this.connection.removeAllListeners();
        }
        this.connection = null;
        this.deepgramClient = null;
        this.connected = false;
        this.ready = false;
        this.lastSendTs = 0;
        this.absoluteTranscript = '';
        this.totalTranscript = '';
    }
}

module.exports = {
    DeepgramLiveClient
};
