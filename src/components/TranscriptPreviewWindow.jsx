import { useEffect, useState } from 'react';
import TranscriptPreview from './TranscriptPreview';
import { clampOpacity } from '../utils/transcriptOpacity';
import { DEFAULT_TRANSCRIPT_OPACITY } from '../../utils/const';

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;

function TranscriptPreviewWindow() {
    const [transcriptOpacity, setTranscriptOpacity] = useState(DEFAULT_TRANSCRIPT_OPACITY);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            if (!electronAPI?.settings?.getGeneral) {
                return;
            }
            try {
                const response = await electronAPI.settings.getGeneral();
                if (!response?.ok || !response?.general) {
                    return;
                }
                const nextOpacity = response.general.transcriptOpacity;
                if (!cancelled && typeof nextOpacity !== 'undefined') {
                    setTranscriptOpacity(clampOpacity(nextOpacity));
                }
            } catch (error) {
                console.warn('[TranscriptPreviewWindow] Failed to load general settings', error);
            }
        };

        load();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (typeof electronAPI?.settings?.onGeneralUpdated !== 'function') {
            return () => { };
        }
        const unsubscribeGeneral = electronAPI.settings.onGeneralUpdated((payload) => {
            const nextOpacity = payload?.general?.transcriptOpacity;
            if (typeof nextOpacity !== 'undefined') {
                setTranscriptOpacity(clampOpacity(nextOpacity));
            }
        });

        const unsubscribePreviewSync = typeof electronAPI?.settings?.onPreviewSync === 'function'
            ? electronAPI.settings.onPreviewSync((payload) => {
                const nextOpacity = payload?.general?.transcriptOpacity;
                if (typeof nextOpacity !== 'undefined') {
                    setTranscriptOpacity(clampOpacity(nextOpacity));
                }
            })
            : () => { };

        return () => {
            if (typeof unsubscribeGeneral === 'function') {
                unsubscribeGeneral();
            }
            if (typeof unsubscribePreviewSync === 'function') {
                unsubscribePreviewSync();
            }
        };
    }, []);

    return <TranscriptPreview opacity={transcriptOpacity} />
}

export default TranscriptPreviewWindow;
