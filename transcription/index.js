const { EventEmitter } = require('node:events');
const { StreamingTranscriptionService } = require('./streaming/service');

class TranscriptionService extends EventEmitter {
    constructor(config) {
        super();
        this.streamingService = new StreamingTranscriptionService(config);
    }

    async init() {
        await this.streamingService.init();

        this.streamingService.on('session-started', (payload) => {
            this.emit('session-started', payload);
        });

        this.streamingService.on('session-update', (payload) => {
            this.emit('session-update', payload);
        });

        this.streamingService.on('session-error', (payload) => {
            this.emit('session-error', payload);
        });

        this.streamingService.on('session-warning', (payload) => {
            this.emit('session-warning', payload);
        });

        this.streamingService.on('session-heartbeat', (payload) => {
            this.emit('session-heartbeat', payload);
        });

        this.streamingService.on('session-stopped', (payload) => {
            this.emit('session-stopped', payload);
        });
    }

    startSession(metadata) {
        return this.streamingService.startSession(metadata);
    }

    pushChunk(sessionId, chunk) {
        return this.streamingService.pushChunk(sessionId, chunk);
    }

    async stopSession(sessionId) {
        await this.streamingService.stopSession(sessionId);
    }

    async stopAllSessions() {
        await this.streamingService.stopAllSessions();
    }
}

async function createTranscriptionService(config) {
    const service = new TranscriptionService(config);
    await service.init();
    return service;
}

module.exports = {
    createTranscriptionService
};
