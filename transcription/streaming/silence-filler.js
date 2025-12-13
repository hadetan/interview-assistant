const DEFAULT_SAMPLE_RATE = 16000;

const buildSilenceFrame = (existingBuffer, silenceFrameMs, sampleRate = DEFAULT_SAMPLE_RATE) => {
    const samples = Math.max(1, Math.floor(sampleRate * (silenceFrameMs / 1000)));
    const bytes = samples * 2; // 16-bit mono
    if (existingBuffer && existingBuffer.length === bytes) {
        return existingBuffer;
    }
    return Buffer.alloc(bytes, 0);
};

module.exports = {
    buildSilenceFrame
};