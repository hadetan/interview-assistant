/**
 * Audio conversion utilities for realtime transcription APIs.
 *
 * Converts WebM/Opus audio chunks from MediaRecorder to raw PCM format:
 * - 16-bit signed integer
 * - Little-endian byte order
 * - Mono channel
 * - 16kHz sample rate
 */

const { spawn } = require('node:child_process');

const LOG_PREFIX = '[AudioConverter]';
const log = (level, message, ...args) => {
    const stamp = new Date().toISOString();
    const logger = console[level] || console.log;
    logger(`${LOG_PREFIX} ${stamp} ${message}`, ...args);
};

/**
 * Persistent streaming audio converter.
 * Maintains a long-running ffmpeg process that can continuously
 * convert WebM/Opus chunks to PCM.
 */
class PersistentAudioConverter {
    constructor(options = {}) {
        this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
        this.inputMimeType = options.mimeType || 'audio/webm;codecs=opus';
        this.ffmpegProcess = null;
        this.outputChunks = [];
        this.isRunning = false;
        this.onData = options.onData || null;
        this.onError = options.onError || null;
    }

    /**
     * Start the persistent ffmpeg process
     */
    start() {
        if (this.isRunning) {
            return;
        }

        // Determine input format from mime type
        let inputFormat = 'webm';
        if (this.inputMimeType.includes('ogg')) {
            inputFormat = 'ogg';
        }

        // ffmpeg arguments for streaming conversion:
        // -f <format>: input format
        // -i pipe:0: read from stdin
        // -f s16le: output format (signed 16-bit little-endian)
        // -acodec pcm_s16le: audio codec
        // -ar 16000: sample rate 16kHz
        // -ac 1: mono channel
        // pipe:1: write to stdout
        const args = [
            '-f', inputFormat,
            '-i', 'pipe:0',
            // Reduce latency with smaller probing and low-latency flags
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            '-probesize', '32',
            '-analyzeduration', '0',
            '-threads', '1',
            '-f', 's16le',
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            '-loglevel', 'error',
            'pipe:1'
        ];

        this.ffmpegProcess = spawn(this.ffmpegPath, args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.ffmpegProcess.stdout.on('data', (chunk) => {
            const now = Date.now();
            if (this.onData) {
                // Provide a short profiling object so callers can timestamp when PCM was produced
                try {
                    this.onData(chunk, { producedAt: now, length: chunk?.length || 0 });
                } catch (err) {
                    log('warn', 'onData threw:', err.message);
                }
            } else {
                this.outputChunks.push(chunk);
            }
        });

        this.ffmpegProcess.stderr.on('data', (data) => {
            const message = data.toString().trim();
            if (message && !message.includes('deprecated')) {
                log('warn', 'ffmpeg: ' + message);
            }
        });

        this.ffmpegProcess.on('close', (code) => {
            if (code !== 0 && this.isRunning) {
                log('warn', 'ffmpeg process exited with code ' + code);
            }
            this.isRunning = false;
        });

        this.ffmpegProcess.on('error', (error) => {
            log('error', 'ffmpeg process error: ' + error.message);
            if (this.onError) {
                this.onError(error);
            }
            this.isRunning = false;
        });

        this.isRunning = true;
        log('info', 'Persistent audio converter started');
    }

    /**
     * Push audio data for conversion
     * @param {Buffer} chunk - WebM audio chunk
     */
    push(chunk) {
        if (!this.isRunning || !this.ffmpegProcess) {
            return false;
        }

        if (Buffer.isBuffer(chunk) && chunk.length > 0) {
            try {
                const canWrite = this.ffmpegProcess.stdin.write(chunk);
                if (!canWrite) {
                    log('warn', 'ffmpeg stdin backpressure: write returned false');
                }
                return canWrite;
            } catch (error) {
                log('error', 'Failed to write to ffmpeg: ' + error.message);
                return false;
            }
        }
        return false;
    }

    /**
     * Get any available PCM output
     * @returns {Buffer} - PCM audio data
     */
    read() {
        if (this.outputChunks.length === 0) {
            return Buffer.alloc(0);
        }

        const result = Buffer.concat(this.outputChunks);
        this.outputChunks = [];
        return result;
    }

    /**
     * Stop the converter
     */
    stop() {
        if (this.ffmpegProcess) {
            try {
                this.ffmpegProcess.stdin.end();
            } catch (error) {
                // Ignore
            }
            
            // Give it a moment to finish, then kill
            setTimeout(() => {
                if (this.ffmpegProcess) {
                    try {
                        this.ffmpegProcess.kill('SIGTERM');
                    } catch (e) {
                        // Ignore
                    }
                    this.ffmpegProcess = null;
                }
            }, 500);
        }
        this.isRunning = false;
        this.outputChunks = [];
        log('info', 'Persistent audio converter stopped');
    }
}

module.exports = {
    PersistentAudioConverter
};
