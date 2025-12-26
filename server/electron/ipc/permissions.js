const registerPermissionHandlers = ({
    ipcMain,
    permissionManager,
    sendPermissionStatus,
    onPermissionsGranted,
    logger = console
}) => {
    if (!ipcMain?.handle) {
        throw new Error('ipcMain.handle is required to register permission handlers.');
    }
    if (!permissionManager || typeof permissionManager.getStatus !== 'function') {
        throw new Error('permissionManager with getStatus is required.');
    }
    const emitStatusToWindow = (status) => {
        if (typeof sendPermissionStatus !== 'function') {
            return;
        }
        try {
            sendPermissionStatus(status);
        } catch (error) {
            logger.warn('[Permissions] Failed to emit status to window', error);
        }
    };

    ipcMain.handle('permissions:get-status', async () => {
        const status = permissionManager.getStatus();
        emitStatusToWindow(status);
        return status;
    });

    ipcMain.handle('permissions:refresh-status', async () => {
        const status = permissionManager.refreshStatus();
        emitStatusToWindow(status);
        return status;
    });

    ipcMain.handle('permissions:acknowledge', async () => {
        const status = permissionManager.refreshStatus();
        emitStatusToWindow(status);
        if (typeof onPermissionsGranted === 'function' && status.allGranted) {
            onPermissionsGranted(status);
        }
        return status;
    });

    return {
        emitStatusToWindow
    };
};

module.exports = {
    registerPermissionHandlers
};