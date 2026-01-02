import { useEffect, useMemo, useRef, useState } from 'react';
import { clampOpacity, TRANSCRIPT_OPACITY_OPTIONS } from '../utils/transcriptOpacity';
import './css/SettingsWindow.css';
import { DEFAULT_TRANSCRIPT_OPACITY } from '../../utils/const';
import { logout as logoutFromApi } from '../utils/apiClient.js';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;

const emptyMissing = { provider: true, model: true, apiKey: true };

const toTitleCase = (value) => value.replace(/(^.|-.|_.|\s.)/g, (segment) => segment.replace(/[-_\s]/g, '').toUpperCase());

function SettingsWindow() {
    const [providers, setProviders] = useState([]);
    const [provider, setProvider] = useState('');
    const [models, setModels] = useState([]);
    const [model, setModel] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [hasStoredSecret, setHasStoredSecret] = useState(false);
    const [missing, setMissing] = useState(emptyMissing);
    const [status, setStatus] = useState({ type: 'info', message: '' });
    const [checking, setChecking] = useState(false);
    const [saving, setSaving] = useState(false);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [connectionVerified, setConnectionVerified] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const [hasSavedConfig, setHasSavedConfig] = useState(false);
    const [activeTab, setActiveTab] = useState('assistant');
    const [transcriptOpacity, setTranscriptOpacity] = useState(DEFAULT_TRANSCRIPT_OPACITY);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewBusy, setPreviewBusy] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const [accountStatus, setAccountStatus] = useState({ type: 'info', message: '' });

    const clampedOpacity = useMemo(() => clampOpacity(transcriptOpacity), [transcriptOpacity]);

    const activeOpacityLabel = useMemo(() => {
        const selected = TRANSCRIPT_OPACITY_OPTIONS.find(({ value }) => Math.abs(value - clampedOpacity) < 0.001);
        if (selected) {
            return selected.label;
        }
        return clampedOpacity.toFixed(2);
    }, [clampedOpacity]);

    const sliderProgress = useMemo(() => {
        const min = 0.25;
        const max = 1;
        const normalized = (Math.min(max, Math.max(min, clampedOpacity)) - min) / (max - min);
        return Math.min(100, Math.max(0, normalized * 100));
    }, [clampedOpacity]);

    const modelsRequestIdRef = useRef(0);
    const fetchModelsTimeoutRef = useRef(null);

    const providerOptions = useMemo(() => providers.map((name) => ({ value: name, label: toTitleCase(name) })), [providers]);

    useEffect(() => {
        if (typeof window === 'undefined' || !hasSavedConfig) {
            return () => { };
        }

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                electronAPI?.settings?.close?.();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [hasSavedConfig]);

    useEffect(() => () => {
        if (fetchModelsTimeoutRef.current) {
            clearTimeout(fetchModelsTimeoutRef.current);
            fetchModelsTimeoutRef.current = null;
        }
    }, []);

    useEffect(() => {
        const load = async () => {
            try {
                setStatus({ type: 'info', message: 'Loading assistant settings…' });
                const result = await electronAPI?.settings?.get?.();
                if (!result?.ok) {
                    throw new Error(result?.error || 'Unable to load settings.');
                }
                setProviders(Array.isArray(result.providers) ? result.providers : []);
                const config = result.config || {};
                const nextProvider = typeof config.provider === 'string' ? config.provider : '';
                const nextModel = typeof config.model === 'string' ? config.model : '';
                const generalSettings = typeof result.general === 'object' && result.general !== null
                    ? result.general
                    : {};
                const resolvedOpacity = generalSettings.transcriptOpacity !== undefined
                    ? generalSettings.transcriptOpacity
                    : DEFAULT_TRANSCRIPT_OPACITY;
                setTranscriptOpacity(clampOpacity(resolvedOpacity));
                setProvider(nextProvider);
                setModel(nextModel);
                setHasStoredSecret(Boolean(result.hasSecret));
                setMissing(result.missing || emptyMissing);
                setPreviewOpen(Boolean(result.previewOpen));
                const storedConfigured = !(result?.missing?.provider || result?.missing?.model || result?.missing?.apiKey);
                setHasSavedConfig(storedConfigured);
                setActiveTab(storedConfigured ? 'general' : 'assistant');
                if (nextProvider) {
                    await loadModels(nextProvider, {
                        apiKeyOverride: '',
                        ensureContainsModel: nextModel,
                        skipStatus: true
                    });
                }
                setStatus({ type: 'success', message: '' });
            } catch (error) {
                setStatus({ type: 'error', message: error?.message || 'Failed to load settings.' });
            } finally {
                setInitialized(true);
            }
        };
        load();
    }, []);

    useEffect(() => {
        setConnectionVerified(false);
        setStatus((current) => current.type === 'error' ? current : { type: 'info', message: '' });
    }, [provider, apiKey]);

    useEffect(() => {
        if (typeof electronAPI?.settings?.onPreviewClosed !== 'function') {
            return () => {};
        }
        const unsubscribe = electronAPI.settings.onPreviewClosed(() => {
            setPreviewOpen(false);
            setPreviewBusy(false);
            setStatus((current) => (current.type === 'error' ? current : { type: 'info', message: '' }));
        });
        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        };
    }, []);

    useEffect(() => {
        if (!previewOpen || typeof electronAPI?.settings?.syncPreview !== 'function') {
            return;
        }
        try {
            electronAPI.settings.syncPreview({ general: { transcriptOpacity: clampOpacity(transcriptOpacity) } });
        } catch (_error) {
            // ignore sync failures
        }
    }, [previewOpen, transcriptOpacity]);

    const loadModels = async (targetProvider, { apiKeyOverride = '', ensureContainsModel = '', skipStatus = false } = {}) => {
        const requestId = ++modelsRequestIdRef.current;

        if (!targetProvider) {
            if (requestId === modelsRequestIdRef.current) {
                setModels([]);
                setModelsLoading(false);
            }
            return;
        }
        setModelsLoading(true);
        if (!skipStatus) {
            setStatus({ type: 'info', message: 'Fetching models…' });
        }
        try {
            const result = await electronAPI?.settings?.listModels?.({
                provider: targetProvider,
                apiKey: apiKeyOverride || undefined
            });
            if (!result?.ok) {
                throw new Error(result?.error || 'Failed to fetch models.');
            }
            let items = Array.isArray(result.models) ? result.models : [];
            if (ensureContainsModel && ensureContainsModel.trim()) {
                const exists = items.some((item) => item.id === ensureContainsModel);
                if (!exists) {
                    items = [...items, { id: ensureContainsModel, name: ensureContainsModel }];
                }
            }
            if (requestId === modelsRequestIdRef.current) {
                setModels(items);
                if (!skipStatus) {
                    setStatus({ type: 'success', message: `Loaded ${items.length} model${items.length === 1 ? '' : 's'}.` });
                }
            }
        } catch (error) {
            if (requestId === modelsRequestIdRef.current) {
                setStatus({ type: 'error', message: error?.message || 'Failed to fetch models.' });
            }
        } finally {
            if (requestId === modelsRequestIdRef.current) {
                setModelsLoading(false);
            }
        }
    };

    const handleProviderChange = async (event) => {
        const nextProvider = event.target.value;
        const hadStoredSecret = hasStoredSecret;
        setProvider(nextProvider);
        setModel('');
        setModels([]);
        setModelsLoading(false);
        setHasStoredSecret(false);
        setMissing((prev) => ({ ...prev, provider: !nextProvider, model: true, apiKey: true }));
        if (fetchModelsTimeoutRef.current) {
            clearTimeout(fetchModelsTimeoutRef.current);
            fetchModelsTimeoutRef.current = null;
        }
        modelsRequestIdRef.current += 1;
        const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
        if (nextProvider && (trimmedKey || hadStoredSecret)) {
            await loadModels(nextProvider, { apiKeyOverride: trimmedKey, skipStatus: true });
        }
    };

    const handleModelChange = (event) => {
        setModel(event.target.value);
        setMissing((prev) => ({ ...prev, model: !event.target.value }));
    };

    const handleApiKeyChange = async (event) => {
        const value = event.target.value;
        const trimmed = typeof value === 'string' ? value.trim() : '';
        setApiKey(value);
        setHasStoredSecret(false);
        setMissing((prev) => ({ ...prev, apiKey: !trimmed }));

        if (!provider) {
            if (fetchModelsTimeoutRef.current) {
                clearTimeout(fetchModelsTimeoutRef.current);
                fetchModelsTimeoutRef.current = null;
            }
            modelsRequestIdRef.current += 1;
            return;
        }

        if (!trimmed) {
            if (fetchModelsTimeoutRef.current) {
                clearTimeout(fetchModelsTimeoutRef.current);
                fetchModelsTimeoutRef.current = null;
            }
            modelsRequestIdRef.current += 1;
            setModels([]);
            setModelsLoading(false);
            return;
        }

        if (fetchModelsTimeoutRef.current) {
            clearTimeout(fetchModelsTimeoutRef.current);
        }

        fetchModelsTimeoutRef.current = setTimeout(() => {
            fetchModelsTimeoutRef.current = null;
            loadModels(provider, { apiKeyOverride: trimmed });
        }, 350);
    };

    const handleClose = () => {
        if (!hasSavedConfig) {
            return;
        }
        electronAPI?.settings?.close?.();
    };

    const handleCheckConnection = async () => {
        if (!provider) {
            setStatus({ type: 'error', message: 'Select a provider first.' });
            return;
        }
        const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
        setChecking(true);
        setStatus({ type: 'info', message: 'Testing connection…' });
        try {
            const result = await electronAPI?.settings?.testConnection?.({
                provider,
                apiKey: trimmedKey || undefined
            });
            if (!result?.ok) {
                throw new Error(result?.error || 'Connection failed.');
            }
            setStatus({ type: 'success', message: 'Connection verified. Continue by saving the settings' });
            setConnectionVerified(true);
            await loadModels(provider, {
                apiKeyOverride: trimmedKey,
                ensureContainsModel: model,
                skipStatus: true
            });
        } catch (error) {
            setConnectionVerified(false);
            setStatus({ type: 'error', message: error?.message || 'Connection failed.' });
        } finally {
            setChecking(false);
        }
    };

    const handleLogout = async () => {
        if (loggingOut) {
            return;
        }
        setLoggingOut(true);
        setAccountStatus({ type: 'info', message: 'Signing out…' });
        try {
            await logoutFromApi();
            setAccountStatus({ type: 'success', message: 'Signed out. Redirecting to sign-in…' });
        } catch (error) {
            console.error('[SettingsWindow] Failed to sign out', error);
            const message = error?.response?.data?.message || error?.message || 'Failed to sign out. Please try again.';
            setAccountStatus({ type: 'error', message });
        } finally {
            setLoggingOut(false);
        }
    };

    const handleOpacityChange = (value) => {
        const clamped = clampOpacity(value);
        setTranscriptOpacity(clamped);
        if (previewOpen && typeof electronAPI?.settings?.syncPreview === 'function') {
            try {
                electronAPI.settings.syncPreview({ general: { transcriptOpacity: clamped } });
            } catch (_error) {
                // ignore sync failures
            }
        }
    };

    const persistSettings = async ({
        requireVerifiedConnection = false,
        savingMessage = 'Saving settings…',
        successMessage = 'Settings saved. You can close this window.'
    } = {}) => {
        if (!provider || !model) {
            setStatus({ type: 'error', message: 'Select both provider and model before saving.' });
            return false;
        }

        if (requireVerifiedConnection && (!connectionVerified || missing.model)) {
            setStatus({ type: 'error', message: 'Verify the connection before saving.' });
            return false;
        }

        if (typeof electronAPI?.settings?.set !== 'function') {
            setStatus({ type: 'error', message: 'Settings API is unavailable.' });
            return false;
        }

        setSaving(true);
        setStatus({ type: 'info', message: savingMessage });

        try {
            const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
            const payload = {
                provider,
                model,
                apiKey: trimmedKey || undefined,
                providerConfig: {},
                general: {
                    transcriptOpacity: clampOpacity(transcriptOpacity)
                }
            };
            const result = await electronAPI.settings.set(payload);
            if (!result?.ok) {
                throw new Error(result?.error || 'Failed to save settings.');
            }
            setStatus({ type: 'success', message: successMessage });
            setHasSavedConfig(true);
            return true;
        } catch (error) {
            setStatus({ type: 'error', message: error?.message || 'Failed to save settings.' });
            return false;
        } finally {
            setSaving(false);
        }
    };

    const handleSave = async () => {
        await persistSettings({ requireVerifiedConnection: true });
    };

    const handleGeneralSave = async () => {
        await persistSettings({
            savingMessage: 'Saving preferences…',
            successMessage: 'Transcript preferences saved.'
        });
    };

    const handlePreviewToggle = async () => {
        if (previewBusy || typeof electronAPI?.settings !== 'object' || electronAPI.settings === null) {
            return;
        }

        const targetState = !previewOpen;
        setPreviewBusy(true);

        try {
            if (targetState) {
                const response = await electronAPI.settings.openPreview();
                if (!response?.ok) {
                    throw new Error(response?.error || 'Failed to open preview window.');
                }
                setPreviewOpen(true);
                if (typeof electronAPI.settings.syncPreview === 'function') {
                    electronAPI.settings.syncPreview({ general: { transcriptOpacity: clampOpacity(transcriptOpacity) } });
                }
            } else {
                const response = await electronAPI.settings.closePreview();
                if (!response?.ok) {
                    throw new Error(response?.error || 'Failed to close preview window.');
                }
                setPreviewOpen(false);
            }
            setStatus({ type: 'success', message: '' });
        } catch (error) {
            setStatus({ type: 'error', message: error?.message || (targetState ? 'Failed to open preview window.' : 'Failed to close preview window.') });
        } finally {
            setPreviewBusy(false);
        }
    };

    const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    const showSaveButton = connectionVerified && !missing.model;
    const canCheckConnection = provider && (normalizedApiKey || hasStoredSecret);
    const canSave = showSaveButton && !saving;
    const canSaveGeneral = Boolean(provider && model) && !saving;
    const isOnboarding = !hasSavedConfig;

    const tabs = useMemo(() => (
        hasSavedConfig
            ? [
                { id: 'general', label: 'General' },
                { id: 'account', label: 'Account' },
                { id: 'assistant', label: 'Assistant' }
            ]
            : []
    ), [hasSavedConfig]);

    const renderAssistantPanel = () => (
        <div className="settings-panel assistant">
            <div className="settings-field">
                <label htmlFor="assistant-provider">Assistant Provider</label>
                <select
                    id="assistant-provider"
                    value={provider}
                    onChange={handleProviderChange}
                >
                    <option value="">Select a provider…</option>
                    {providerOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
            </div>

            <div className="settings-field">
                <label htmlFor="assistant-key">API Key</label>
                <input
                    id="assistant-key"
                    type="password"
                    placeholder={hasStoredSecret ? 'Key stored securely. Enter to replace.' : 'Paste your API key…'}
                    value={apiKey}
                    onChange={handleApiKeyChange}
                    autoComplete="off"
                />
                {hasStoredSecret && !apiKey && (
                    <p className="settings-hint">If left empty then the stored key will be used. Enter a new one to replace it.</p>
                )}
            </div>

            <div className="settings-field">
                <label htmlFor="assistant-model">Model</label>
                <select
                    id="assistant-model"
                    value={model}
                    onChange={handleModelChange}
                    disabled={!provider || modelsLoading}
                >
                    <option value="">Select a model…</option>
                    {models.map((item) => (
                        <option key={item.id} value={item.id}>{item.name || item.id}</option>
                    ))}
                </select>
            </div>

            {status.message && (
                <div className={`settings-status ${status.type}`}>{status.message}</div>
            )}

            <div className="settings-actions">
                {!showSaveButton && (
                    <button
                        type="button"
                        onClick={handleCheckConnection}
                        disabled={checking || !canCheckConnection}
                    >
                        {checking ? 'Checking…' : 'Check Connection'}
                    </button>
                )}
                {showSaveButton && (
                    <button
                        type="button"
                        className="primary"
                        onClick={handleSave}
                        disabled={!canSave}
                    >
                        {saving ? 'Saving…' : 'Save Settings'}
                    </button>
                )}
                {hasSavedConfig && (
                    <button
                        type="button"
                        className="secondary"
                        onClick={handleClose}
                    >
                        Close
                    </button>
                )}
            </div>
        </div>
    );

    const renderGeneralPanel = () => (
        <div className="settings-panel general">
            <div className="settings-card">
                <h2>Transcript Appearance</h2>
                <p>Adjust how transparent the transcript window appears on top of your workspace.</p>

                <div className="settings-field settings-preview-field">
                    <span className="settings-field-label" id="preview-toggle-label">Live preview window</span>
                    <small className="settings-hint">Open a floating transcript window that mirrors these preferences in real time.</small>
                    <div className="preview-switch" role="switch" aria-checked={previewOpen} aria-labelledby="preview-toggle-label">
                        <button
                            type="button"
                            className={`preview-switch-track${previewOpen ? ' preview-switch-track-on' : ''}${previewBusy ? ' preview-switch-track-busy' : ''}`}
                            onClick={handlePreviewToggle}
                            disabled={previewBusy}
                        >
                            <span className={`preview-switch-thumb${previewOpen ? ' preview-switch-thumb-on' : ''}`} />
                        </button>
                        <span className="preview-switch-status" aria-live="polite">
                            {previewBusy ? (previewOpen ? 'Hiding…' : 'Opening…') : (previewOpen ? 'Preview visible' : 'Preview hidden')}
                        </span>
                    </div>
                </div>

                <div className="settings-field settings-opacity-field">
                    <span className="settings-field-label" id="transcript-opacity-label">Opacity level</span>
                    <small className="settings-hint">Higher value reduces transparency</small>
                    <div
                        className="opacity-slider-control"
                        role="group"
                        aria-labelledby="transcript-opacity-label"
                    >
                        <div className="opacity-slider-rail">
                            <input
                                type="range"
                                min="0.25"
                                max="1"
                                step="0.125"
                                value={clampedOpacity}
                                onChange={(event) => handleOpacityChange(Number(event.target.value))}
                                className="opacity-slider-input"
                                aria-valuemin={0.25}
                                aria-valuemax={1}
                                aria-valuenow={Number(clampedOpacity.toFixed(3))}
                                aria-valuetext={`${activeOpacityLabel} opacity`}
                                style={{ '--opacity-progress': `${sliderProgress}%` }}
                            />
                        </div>
                        <span className="opacity-slider-value" aria-live="polite">
                            {activeOpacityLabel} opacity
                        </span>
                    </div>
                </div>
            </div>

            {status.message && (
                <div className={`settings-status ${status.type}`}>{status.message}</div>
            )}

            <div className="settings-actions">
                <button
                    type="button"
                    className="primary"
                    onClick={handleGeneralSave}
                    disabled={!canSaveGeneral}
                >
                    {saving ? 'Saving…' : 'Save Preferences'}
                </button>
                <button
                    type="button"
                    className="secondary"
                    onClick={handleClose}
                >
                    Close
                </button>
            </div>
        </div>
    );

    const renderAccountPanel = () => (
        <div className="settings-panel account">
            <div className="settings-card">
                <h2>Account</h2>
                <p>Sign out to switch Google accounts or secure the assistant.</p>
                <p>Logging out clears the local auth.json and returns you to the sign-in window.</p>
            </div>

            {accountStatus.message && (
                <div className={`settings-status ${accountStatus.type}`}>{accountStatus.message}</div>
            )}

            <div className="settings-actions">
                <button
                    type="button"
                    className="primary"
                    onClick={handleLogout}
                    disabled={loggingOut}
                >
                    {loggingOut ? 'Signing out…' : 'Log Out'}
                </button>
                <button
                    type="button"
                    className="secondary"
                    onClick={handleClose}
                    disabled={loggingOut}
                >
                    Close
                </button>
            </div>
        </div>
    );

    if (!initialized) {
        return (
            <div className="settings-window loading-state">
                <div className="settings-loading-card" role="status" aria-live="polite">
                    <div className="settings-loading-spinner" aria-hidden="true" />
                    <p>Initializing settings…</p>
                </div>
            </div>
        );
    }

    return (
        <div className="settings-window">
            <header>
                {initialized ? (
                    hasSavedConfig ? (
                        <>
                            <h1>Settings</h1>
                        </>
                    ) : (
                        <>
                            <h1>Onboarding</h1>
                            <h3>Please configure and pick your preferred AI provider</h3>
                            <p>This will be used to answer the asked questions by interviewer and/or solve code problems</p>
                        </>
                    )
                ) : null}
            </header>

            {hasSavedConfig && (
                <nav className="settings-tabs" role="tablist" aria-label="Settings Tabs">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            className="settings-tab"
                            role="tab"
                            aria-selected={activeTab === tab.id}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </nav>
            )}

            {isOnboarding && renderAssistantPanel()}
            {!isOnboarding && activeTab === 'assistant' && renderAssistantPanel()}
            {!isOnboarding && activeTab === 'general' && renderGeneralPanel()}
            {!isOnboarding && activeTab === 'account' && renderAccountPanel()}
        </div>
    );
}

export default SettingsWindow;
