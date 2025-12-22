const buildChunkMeta = (lastChunkMeta, lastSequence, producedAt) => {
    if (lastChunkMeta) {
        lastChunkMeta.converterProducedTs = producedAt;
    }
    const meta = lastChunkMeta ? { ...lastChunkMeta } : {};
    meta.segmentProducedTs = producedAt;
    if (typeof meta.sequence !== 'number') {
        meta.sequence = lastSequence;
    }
    return meta;
};

module.exports = {
    buildChunkMeta
};