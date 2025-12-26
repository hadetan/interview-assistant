const grantedStates = new Set(['granted', 'authorized']);

const normalizeStatus = (rawStatus) => {
    const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : 'unknown';
    return status || 'unknown';
};

const buildDefaultStatus = (platform) => {
    const isMac = platform === 'darwin';
    const microphoneStatus = isMac ? 'unknown' : 'granted';
    const screenStatus = isMac ? 'unknown' : 'granted';
    const checks = {
        microphone: {
            status: microphoneStatus,
            granted: grantedStates.has(microphoneStatus)
        },
        screen: {
            status: screenStatus,
            granted: grantedStates.has(screenStatus)
        }
    };

    return {
        platform,
        updatedAt: Date.now(),
        checks,
        missing: [],
        allGranted: !isMac
    };
};

const computeMissing = (checks) => Object.entries(checks)
    .filter(([, entry]) => !entry?.granted)
    .map(([key]) => key);

const safeGetMediaAccessStatus = (systemPreferences, mediaType) => {
    if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== 'function') {
        return 'unknown';
    }

    try {
        return normalizeStatus(systemPreferences.getMediaAccessStatus(mediaType));
    } catch (error) {
        console.warn(`[Permissions] Failed to read ${mediaType} access status`, error);
        return 'unknown';
    }
};

const createPermissionManager = ({ systemPreferences, platform }) => {
    let cachedStatus = buildDefaultStatus(platform);

    const isMac = platform === 'darwin';

    const computeStatus = () => {
        if (!isMac) {
            const nonMacStatus = buildDefaultStatus(platform);
            nonMacStatus.missing = [];
            nonMacStatus.allGranted = true;
            return nonMacStatus;
        }

        const microphoneStatus = safeGetMediaAccessStatus(systemPreferences, 'microphone');
        const screenStatus = safeGetMediaAccessStatus(systemPreferences, 'screen');

        const checks = {
            microphone: {
                status: microphoneStatus,
                granted: grantedStates.has(microphoneStatus)
            },
            screen: {
                status: screenStatus,
                granted: grantedStates.has(screenStatus)
            }
        };

        const missing = computeMissing(checks);

        return {
            platform,
            updatedAt: Date.now(),
            checks,
            missing,
            allGranted: missing.length === 0
        };
    };

    const refreshStatus = () => {
        cachedStatus = computeStatus();
        return cachedStatus;
    };

    const getStatus = () => {
        if (!cachedStatus || typeof cachedStatus.updatedAt !== 'number') {
            return refreshStatus();
        }
        return cachedStatus;
    };

    return {
        getStatus,
        refreshStatus,
        isMac,
        hasMissingPermissions: () => refreshStatus().missing.length > 0
    };
};

module.exports = {
    createPermissionManager
};