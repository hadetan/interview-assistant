const { EventEmitter } = require('node:events');
const { log, sleep } = require('./helpers');

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
        if (this.counter % 3 === 0) {
            await sleep(100);
            this.emit('transcription', {
                text: `mock transcript ${this.counter}`,
                type: 'final_transcript',
                isFinal: true
            });
        } else {
            this.emit('transcription', {
                text: `mock partial ${this.counter}`,
                type: 'partial_transcript',
                isFinal: false
            });
        }
        return true;
    }

    async disconnect() {
        this.connected = false;
        log('info', 'Mock client disconnected');
    }

    isReady() {
        return this.connected;
    }
}

module.exports = {
    MockStreamingClient
};
