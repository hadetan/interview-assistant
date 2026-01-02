import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { initializeSupabaseClient } from '../utils/supabaseClient.js';
import { getApiClient, setAccessToken as persistAccessToken } from '../utils/apiClient.js';
import './css/AuthWindow.css';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;

const STATUS_MESSAGES = {
    launching: 'Opening your browser for Google sign-in…',
    waiting: 'Complete the Google sign-in in your browser.',
    exchanging: 'Finishing sign-in…'
};

const AuthWindow = () => {
    const [initializing, setInitializing] = useState(true);
    const [isReady, setIsReady] = useState(false);
    const [flowState, setFlowState] = useState('idle');
    const [error, setError] = useState('');
    const [completed, setCompleted] = useState(false);
    const [lastErrorStep, setLastErrorStep] = useState(null);

    const supabaseRef = useRef(null);
    const redirectUriRef = useRef('');
    const flowActiveRef = useRef(false);

    useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const { client, redirectUri } = await initializeSupabaseClient();
                if (!mounted) {
                    return;
                }
                if (!redirectUri) {
                    throw new Error('Supabase redirect URI is missing. Please set SUPABASE_REDIRECT_URI.');
                }
                supabaseRef.current = client;
                redirectUriRef.current = redirectUri;
                setIsReady(true);
                setError('');
            } catch (initError) {
                if (!mounted) {
                    return;
                }
                const message = initError?.message || 'Failed to initialize authentication. Please verify Supabase settings.';
                setError(message);
                setIsReady(false);
            } finally {
                if (mounted) {
                    setInitializing(false);
                }
            }
        })();
        return () => {
            mounted = false;
        };
    }, []);

    const handleOAuthCallback = useCallback(async (payload) => {
        if (!payload || !flowActiveRef.current) {
            return;
        }
        const supabase = supabaseRef.current;
        const fragmentParams = payload.fragmentParams || {};
        const hasFragmentTokens = typeof fragmentParams.access_token === 'string'
            && fragmentParams.access_token
            && typeof fragmentParams.refresh_token === 'string'
            && fragmentParams.refresh_token;
        if (!supabase && !hasFragmentTokens) {
            setError('Authentication client unavailable. Please retry.');
            setFlowState('idle');
            setLastErrorStep('exchange');
            setCompleted(false);
            flowActiveRef.current = false;
            return;
        }
        const callbackError = payload.error
            || payload.errorDescription
            || payload.params?.error
            || fragmentParams.error
            || fragmentParams.error_description;
        if (callbackError) {
            setError(payload.errorDescription || callbackError || 'Google sign-in was cancelled.');
            setFlowState('idle');
            setLastErrorStep('browser');
            setCompleted(false);
            flowActiveRef.current = false;
            return;
        }
        const authCode = payload.code || payload.params?.code || fragmentParams.code;

        setFlowState('exchanging');
        try {
            let session = null;
            if (authCode) {
                if (!supabase) {
                    throw new Error('Supabase client unavailable for code exchange.');
                }
                const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession({ authCode });
                if (exchangeError) {
                    throw new Error(exchangeError.message || 'Failed to finalize Supabase session.');
                }
                session = data?.session || null;
            } else {
                const access = typeof fragmentParams.access_token === 'string' ? fragmentParams.access_token : '';
                const refresh = typeof fragmentParams.refresh_token === 'string' ? fragmentParams.refresh_token : '';
                const expiresValue = fragmentParams.expires_in || fragmentParams.refresh_token_expires_in || fragmentParams.refresh_expires_in;
                const numericExpires = Number(expiresValue);
                const expiresIn = Number.isFinite(numericExpires) ? numericExpires : parseInt(String(expiresValue || ''), 10) || 0;
                const tokenType = typeof fragmentParams.token_type === 'string' ? fragmentParams.token_type : 'bearer';
                if (access && refresh) {
                    session = {
                        access_token: access,
                        refresh_token: refresh,
                        expires_in: expiresIn,
                        token_type: tokenType
                    };
                }
            }

            const accessToken = session?.access_token || '';
            const refreshToken = session?.refresh_token || '';
            const expiresInRaw = session?.expires_in;
            const expiresNumeric = Number(expiresInRaw);
            const expiresIn = Number.isFinite(expiresNumeric) ? expiresNumeric : parseInt(String(expiresInRaw || ''), 10) || 0;
            const tokenType = session?.token_type || 'bearer';

            if (!accessToken || !refreshToken) {
                throw new Error('Supabase session is incomplete. Please retry the Google sign-in.');
            }

            const client = await getApiClient();
            const response = await client.post('/auth/google/session', {
                accessToken,
                refreshToken,
                expiresIn,
                tokenType
            }, { _skipAuthToken: true });

            const backendAccessToken = response?.data?.data?.session?.accessToken;
            if (!backendAccessToken) {
                throw new Error('Backend did not return an access token.');
            }

            await persistAccessToken(backendAccessToken);
            setError('');
            setFlowState('idle');
            setLastErrorStep(null);
            setCompleted(true);
        } catch (exchangeError) {
            const message = exchangeError?.message || 'Authentication failed. Please try again.';
            setError(message);
            setFlowState('idle');
            setLastErrorStep('exchange');
            setCompleted(false);
        } finally {
            flowActiveRef.current = false;
        }
    }, []);

    useEffect(() => {
        if (!electronAPI?.auth?.onOAuthCallback) {
            return () => { };
        }
        const unsubscribe = electronAPI.auth.onOAuthCallback(handleOAuthCallback);
        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        };
    }, [handleOAuthCallback]);

    const handleStart = useCallback(async () => {
        if (!isReady || flowActiveRef.current) {
            return;
        }
        const supabase = supabaseRef.current;
        if (!supabase) {
            setError('Authentication client unavailable. Please retry.');
            setCompleted(false);
            setLastErrorStep('launch');
            return;
        }

        flowActiveRef.current = true;
        setError('');
        setFlowState('launching');
        setCompleted(false);
        setLastErrorStep(null);

        try {
            const { data, error: signInError } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: redirectUriRef.current,
                    skipBrowserRedirect: true
                }
            });

            if (signInError) {
                throw new Error(signInError.message || 'Failed to start Google sign-in.');
            }

            const oauthUrl = data?.url;
            if (!oauthUrl) {
                throw new Error('Supabase did not return a Google sign-in URL.');
            }

            if (electronAPI?.auth?.launchOAuthUrl) {
                const result = await electronAPI.auth.launchOAuthUrl(oauthUrl);
                if (!result?.ok) {
                    throw new Error(result?.error || 'Unable to open the browser for authentication.');
                }
            } else if (typeof window !== 'undefined') {
                window.open(oauthUrl, '_blank', 'noopener');
            }

            setFlowState('waiting');
        } catch (launchError) {
            const message = launchError?.message || 'Failed to start authentication. Please try again.';
            setError(message);
            setFlowState('idle');
            setLastErrorStep('launch');
            setCompleted(false);
            flowActiveRef.current = false;
        }
    }, [isReady]);

    const statusText = useMemo(() => {
        if (error) {
            return '';
        }
        if (initializing) {
            return 'Preparing authentication…';
        }
        return STATUS_MESSAGES[flowState] || '';
    }, [initializing, flowState, error]);

    const buttonDisabled = initializing || !isReady || flowState === 'launching' || flowState === 'waiting' || flowState === 'exchanging';
    const buttonLabel = flowState === 'waiting' ? 'Waiting for Google…' : 'Continue with Google';
    const successText = completed && !error ? 'Signed in successfully. Returning to Capture…' : '';
    const inlineStatus = successText || statusText;

    const stepStates = useMemo(() => {
        const states = { start: 'idle', browser: 'idle', finalize: 'idle' };
        if (completed) {
            states.start = 'done';
            states.browser = 'done';
            states.finalize = 'done';
            return states;
        }
        switch (flowState) {
            case 'launching':
                states.start = 'active';
                break;
            case 'waiting':
                states.start = 'done';
                states.browser = 'active';
                break;
            case 'exchanging':
                states.start = 'done';
                states.browser = 'done';
                states.finalize = 'active';
                break;
            default:
                break;
        }
        if (error && lastErrorStep) {
            if (lastErrorStep === 'launch') {
                states.start = 'error';
                states.browser = 'idle';
                states.finalize = 'idle';
            } else if (lastErrorStep === 'browser') {
                states.start = 'done';
                states.browser = 'error';
                states.finalize = 'idle';
            } else if (lastErrorStep === 'exchange') {
                states.start = 'done';
                states.browser = 'done';
                states.finalize = 'error';
            }
        }
        return states;
    }, [flowState, completed, error, lastErrorStep]);

    const stepStatusLabels = {
        idle: 'Pending',
        active: 'In progress',
        done: 'Complete',
        error: 'Needs attention'
    };

    const steps = [
        {
            key: 'start',
            title: 'Launch Google sign-in',
            body: 'We open your default browser and direct you to the Supabase-hosted Google consent screen.'
        },
        {
            key: 'browser',
            title: 'Approve in your browser',
            body: 'Choose the Google account you use for Capture. Supabase manages the OAuth flow and refresh cookie.'
        },
        {
            key: 'finalize',
            title: 'Securely finish sign-in',
            body: 'We receive the Supabase session, store the access token locally, and the backend keeps the refresh token in an HttpOnly cookie.'
        }
    ];

    return (
        <div className="auth-window" role="presentation">
            <div className="auth-layout">
                <header className="auth-hero">
                    <div className="auth-hero-art" aria-hidden="true">
                        <span className="auth-hero-ring" />
                        <span className="auth-hero-orb" />
                        <span className="auth-hero-glow" />
                        <div className="auth-hero-browser">
                            <div className="auth-browser-bar">
                                <span className="dot" />
                                <span className="dot" />
                                <span className="dot" />
                            </div>
                            <div className="auth-browser-body">
                                <span className="auth-hero-kicker">Interview Assistant</span>
                                <h1>Sign in with Google</h1>
                                <small>
                                    Interview Assistant uses Google OAuth to login.
                                    Authentication is required before you can use the app.
                                </small>
                                <div className="auth-cta-row">
                                    <button
                                        type="button"
                                        className="auth-primary-button"
                                        disabled={buttonDisabled}
                                        onClick={handleStart}
                                    >
                                        {buttonLabel}
                                    </button>
                                    {inlineStatus ? <small className="auth-status-hint">{inlineStatus}</small> : null}
                                </div>
                                {error ? <div className="auth-alert error" role="alert">{error}</div> : null}
                                {successText ? <div className="auth-alert success" role="status">{successText}</div> : null}
                            </div>
                        </div>
                    </div>
                </header>
            </div>
        </div>
    );
};

export default AuthWindow;
