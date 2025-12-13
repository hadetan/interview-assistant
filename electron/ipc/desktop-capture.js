const DEFAULT_TYPES = ['screen', 'window'];
const DEFAULT_THUMBNAIL_SIZE = { width: 320, height: 200 };

const mapSourceToPayload = (source) => ({
    id: source.id,
    name: source.name,
    thumbnail: typeof source.thumbnail?.toDataURL === 'function' ? source.thumbnail.toDataURL() : null,
    display_id: source.display_id || null
});

const resolveOptions = (opts = {}) => {
    const types = Array.isArray(opts.types) && opts.types.length ? opts.types : DEFAULT_TYPES;
    const fetchWindowIcons = typeof opts.fetchWindowIcons === 'boolean' ? opts.fetchWindowIcons : true;
    const hasThumbnailSize = opts.thumbnailSize && Number.isFinite(opts.thumbnailSize.width) && Number.isFinite(opts.thumbnailSize.height);
    const thumbnailSize = hasThumbnailSize ? opts.thumbnailSize : DEFAULT_THUMBNAIL_SIZE;

    return { types, fetchWindowIcons, thumbnailSize };
};

const registerDesktopCaptureHandler = ({ ipcMain, desktopCapturer }) => {
    if (!ipcMain?.handle) {
        throw new Error('ipcMain.handle is required to register desktop capture handler.');
    }
    if (!desktopCapturer?.getSources) {
        throw new Error('desktopCapturer.getSources is required to register desktop capture handler.');
    }

    const handler = async (_event, opts = {}) => {
        const options = resolveOptions(opts);
        const sources = await desktopCapturer.getSources(options);
        return sources.map((source) => mapSourceToPayload(source));
    };

    ipcMain.handle('desktop-capture:get-sources', handler);
    return handler;
};

module.exports = {
    registerDesktopCaptureHandler,
    mapSourceToPayload,
    resolveOptions
};
