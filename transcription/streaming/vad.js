const SUPPORTED_FRAME_MS = new Set([10, 20, 30]);
let wasmModulePromise = null;

const clamp = (value, min, max) => {
    if (Number.isNaN(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, value));
};

async function loadFvadModule() {
    if (!wasmModulePromise) {
        wasmModulePromise = import('@echogarden/fvad-wasm')
            .then((factory) => {
                if (typeof factory?.default !== 'function') {
                    throw new Error('Failed to load @echogarden/fvad-wasm module.');
                }
                return factory.default();
            });
    }
    return wasmModulePromise;
}

class FvadInstance {
    constructor(module, options = {}) {
        this.module = module;
        this.sampleRate = options.sampleRate;
        this.frameMs = options.frameMs;
        this.mode = options.aggressiveness;
        this.frameSamples = Math.floor(this.sampleRate * (this.frameMs / 1000));
        this.frameBytes = this.frameSamples * 2;
        this.pending = Buffer.alloc(0);
        this.handle = this.module._fvad_new();
        if (!this.handle) {
            throw new Error('Unable to allocate VAD instance.');
        }
        const rateResult = this.module._fvad_set_sample_rate(this.handle, this.sampleRate);
        if (rateResult !== 0) {
            throw new Error(`Unsupported VAD sample rate: ${this.sampleRate}`);
        }
        const modeResult = this.module._fvad_set_mode(this.handle, this.mode);
        if (modeResult !== 0) {
            throw new Error(`Failed to set VAD aggressiveness: ${this.mode}`);
        }
        this.framePtr = this.module._malloc(this.frameBytes);
        if (!this.framePtr) {
            throw new Error('Unable to allocate VAD frame buffer.');
        }
    }

    reset() {
        if (this.handle) {
            this.module._fvad_reset(this.handle);
        }
        this.pending = Buffer.alloc(0);
    }

    analyze(buffer) {
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            return {
                speechFrames: 0,
                frameCount: 0,
                speechRatio: 0,
                processedBytes: 0,
                remainderBytes: this.pending.length
            };
        }

        let workBuffer = buffer;
        if (this.pending.length > 0) {
            workBuffer = Buffer.concat([this.pending, buffer]);
            this.pending = Buffer.alloc(0);
        }

        let offset = 0;
        let frameCount = 0;
        let speechFrames = 0;

        while ((offset + this.frameBytes) <= workBuffer.length) {
            const frame = workBuffer.subarray(offset, offset + this.frameBytes);
            offset += this.frameBytes;
            this.module.HEAPU8.set(frame, this.framePtr);
            const decision = this.module._fvad_process(this.handle, this.framePtr, this.frameSamples);
            if (decision === 1) {
                speechFrames += 1;
            }
            frameCount += 1;
        }

        if (offset < workBuffer.length) {
            this.pending = workBuffer.subarray(offset);
        }

        return {
            speechFrames,
            frameCount,
            speechRatio: frameCount > 0 ? speechFrames / frameCount : 0,
            processedBytes: offset,
            remainderBytes: this.pending.length
        };
    }

    dispose() {
        if (this.framePtr) {
            this.module._free(this.framePtr);
            this.framePtr = null;
        }
        if (this.handle) {
            this.module._fvad_free(this.handle);
            this.handle = null;
        }
        this.pending = Buffer.alloc(0);
    }
}

async function createVadInstance(options = {}) {
    const module = await loadFvadModule();
    return new FvadInstance(module, options);
}

module.exports = {
    createVadInstance,
    normalizeFrameMs,
    SUPPORTED_FRAME_MS
};
