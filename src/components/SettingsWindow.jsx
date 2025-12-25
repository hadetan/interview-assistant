import { useEffect, useMemo, useRef, useState } from 'react';

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

    const modelsRequestIdRef = useRef(0);
    const fetchModelsTimeoutRef = useRef(null);

    const providerOptions = useMemo(() => providers.map((name) => ({ value: name, label: toTitleCase(name) })), [providers]);

    useEffect(() => {
        if (typeof window === 'undefined' || !hasSavedConfig) {
            return () => {};
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
                setProvider(nextProvider);
                setModel(nextModel);
                setHasStoredSecret(Boolean(result.hasSecret));
                setMissing(result.missing || emptyMissing);
                const storedConfigured = !(result?.missing?.provider || result?.missing?.model || result?.missing?.apiKey);
                setHasSavedConfig(storedConfigured);
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
            setStatus({ type: 'success', message: 'Connection verified. Select a model and save to finish.' });
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

    const handleSave = async () => {
        if (!provider || !model) {
            setStatus({ type: 'error', message: 'Select both provider and model before saving.' });
            return;
        }
        setSaving(true);
        setStatus({ type: 'info', message: 'Saving settings…' });
        try {
            const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
            const payload = {
                provider,
                model,
                apiKey: trimmedKey || undefined,
                providerConfig: {}
            };
            const result = await electronAPI?.settings?.set?.(payload);
            if (!result?.ok) {
                throw new Error(result?.error || 'Failed to save settings.');
            }
            setStatus({ type: 'success', message: 'Settings saved. You can close this window.' });
            setHasSavedConfig(true);
        } catch (error) {
            setStatus({ type: 'error', message: error?.message || 'Failed to save settings.' });
        } finally {
            setSaving(false);
        }
    };

    const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    const showSaveButton = connectionVerified && !missing.model;
    const canCheckConnection = provider && (normalizedApiKey || hasStoredSecret);
    const canSave = showSaveButton && !saving;

    if (!initialized) return <div className="loading">Initializing…</div>;

    return (
        <div className="settings-window">
            <header>
                {initialized ? (
                    hasSavedConfig ? (
                        <h1>Settings</h1>
                    ) : (
                        <>
                            <h1>Onboarding</h1>
                            <h3>Please configure and pick your preferred AI provider</h3>
                            <p>This will be used to answer the asked questions by interviewer and/or solve code problems</p>
                        </>
                    )
                ) : null}
            </header>

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
}

export default SettingsWindow;
