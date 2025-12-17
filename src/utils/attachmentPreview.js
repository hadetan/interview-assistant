const DEFAULT_MIME = 'image/png';
const DEFAULT_NAME = 'capture';

const createFallbackId = (fallbackId) => fallbackId || `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function buildAttachmentPreview({ image = {}, metadata = {}, fallbackId } = {}) {
    const source = image || {};
    const meta = metadata || {};
    const mime = meta.mime || source.mime || DEFAULT_MIME;
    const data = typeof source.data === 'string' ? source.data : '';
    const dataUrl = source.dataUrl || (data ? `data:${mime};base64,${data}` : '');
    const id = meta.id || source.id || createFallbackId(fallbackId);
    const name = meta.name || source.name || DEFAULT_NAME;

    return {
        id,
        name,
        mime,
        data,
        dataUrl
    };
}

export function mergeAttachmentPreviews(existing = [], incoming = []) {
    const seen = new Set();
    const result = [];

    const append = (attachment, allowOverride = false) => {
        if (!attachment) {
            return;
        }
        const id = attachment.id;
        if (!id) {
            result.push(attachment);
            return;
        }
        if (!seen.has(id)) {
            seen.add(id);
            result.push(attachment);
            return;
        }
        if (allowOverride) {
            const index = result.findIndex((item) => item.id === id);
            if (index !== -1) {
                result[index] = attachment;
            }
        }
    };

    existing.forEach((item) => append(item, false));
    incoming.forEach((item) => append(item, true));

    return result;
}
