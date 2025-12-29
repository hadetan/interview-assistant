const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { AssemblyLiveClient } = require('./providers/assembly-client');
const { DeepgramLiveClient } = require('./providers/deepgram-client');
const { MockStreamingClient } = require('./mock-client');
const { LiveStreamingSession } = require('./live-session');
const { log } = require('./helpers');

const SUPPORTED_PROVIDERS = new Set(['assembly', 'deepgram']);

class StreamingTranscriptionService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.ffmpegPath = config?.ffmpegPath || null;
        this.provider = (config?.provider || 'assembly').toLowerCase();
        this.providerConfig = config?.providerConfig || {};
        this.sessions = new Map();
        this.ready = false;
    }

    async init() {
        if (!SUPPORTED_PROVIDERS.has(this.provider)) {
            throw new Error(`Unsupported transcription provider: ${this.provider}`);
        }

        const providerSettings = this.providerConfig?.[this.provider] || {};

        if (!this.config.streaming?.mock && !providerSettings?.apiKey) {
            throw new Error(`TRANSCRIPTION_API_KEY must be configured for provider ${this.provider}.`);
        }

        this.ready = true;
        const providerLabel = this.provider === 'deepgram' ? 'Deepgram realtime' : 'AssemblyAI realtime';
        if (this.ffmpegPath) {
            log('info', `Streaming transcription service initialized (${providerLabel}) - ffmpeg=${this.ffmpegPath}`);
        } else {
            log('warn', `Streaming transcription service initialized (${providerLabel}) without explicit FFmpeg path - (falling back to system PATH)`);
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

        const providerSettings = this.providerConfig?.[this.provider] || {};

        if (this.provider === 'deepgram') {
            const liveOptions = { ...(this.config.streaming?.deepgramParams || {}) };
            return new DeepgramLiveClient({
                apiKey: providerSettings.apiKey,
                sampleRate: liveOptions.sample_rate,
                encoding: liveOptions.encoding,
                channels: liveOptions.channels,
                liveOptions,
                clientOptions: providerSettings.clientOptions || {}
            });
        }

        return new AssemblyLiveClient({
            apiKey: providerSettings.apiKey,
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
            sourceName: metadata.sourceName,
            sourceType: metadata.sourceType,
            client,
            streamingConfig: this.config.streaming,
            ffmpegPath: metadata.ffmpegPath || this.ffmpegPath,
            converterFactory: metadata.converterFactory
        });

        session.on('update', (payload) => {
            const deltaSize = typeof payload.delta === 'string' ? payload.delta.length : 0;
            const latencyMs = typeof payload.latencyMs === 'number' ? payload.latencyMs : undefined;
            const pipelineMs = typeof payload.pipelineMs === 'number' ? payload.pipelineMs : undefined;
            log('info', `Session ${sessionId} update (${deltaSize} chars) ws:${latencyMs ?? '-'}ms e2e:${pipelineMs ?? '-'}ms`);
            this.emit('session-update', {
                sessionId,
                sourceName: session.sourceName,
                sourceType: session.sourceType,
                ...payload
            });
        });

        session.on('error', (error) => {
            log('error', `Session ${sessionId} error: ${error.message}`);
            this.emit('session-error', {
                sessionId,
                sourceType: session.sourceType,
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
                sourceType: session.sourceType,
                warning: payload
            });
        });

        session.on('heartbeat', (payload = {}) => {
            this.emit('session-heartbeat', {
                sessionId,
                sourceName: session.sourceName,
                sourceType: session.sourceType,
                ...payload
            });
        });

        this.sessions.set(sessionId, session);

        // Start the Live API connection
        try {
            await session.start();
            log('info', `Session ${sessionId} started for ${session.sourceName}`);
            this.emit('session-started', { sessionId, sourceName: session.sourceName, sourceType: session.sourceType });
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
        this.emit('session-stopped', { sessionId, sourceType: session?.sourceType });
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
