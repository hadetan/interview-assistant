import { useMemo } from 'react';
import ChatBubble from './ChatBubble';
import { clampOpacity, computeTranscriptOpacityVars } from '../utils/transcriptOpacity';
import './css/TranscriptPreview.css';

const PREVIEW_MESSAGES = [
    {
        id: 'preview-interviewer',
        side: 'left',
        text: 'Could you sketch a debounce helper for noisy input? We want to limit API calls.',
        isFinal: true,
        sourceType: 'interviewer',
        sent: true
    },
    {
        id: 'preview-user',
        side: 'left',
        text: 'We can wrap the callback and only run it after the user pauses typing.',
        isFinal: true,
        sourceType: 'mic',
        sent: true
    },
    {
        id: 'preview-ai',
        side: 'right',
        text: 'Here\'s a debounce helper:```js\nexport function debounce(fn, delay = 200) {\n    let timer = null;\n    return (...args) => {\n        if (timer) {\n            clearTimeout(timer);\n        }\n        timer = setTimeout(() => {\n            fn(...args);\n            timer = null;\n        }, delay);\n    };\n}\n```',
        isFinal: true,
        sourceType: 'assistant',
        sent: true
    }
];

export default function TranscriptPreview({ opacity }) {
    const normalizedOpacity = clampOpacity(opacity);
    const opacityStyles = useMemo(() => computeTranscriptOpacityVars(normalizedOpacity), [normalizedOpacity]);

    return (
        <div className="transcript-shell transcript-preview" style={opacityStyles}>
            <section className="transcript-panel transcript-preview-panel" aria-label="Transcript appearance preview">
                <header className="transcript-heading transcript-preview-heading">
                    <span className="heading-chip">Preview</span>
                </header>
                <div className="transcript-body transcript-preview-body">
                    <div className="chat-container">
                        {PREVIEW_MESSAGES.map((msg) => (
                            <ChatBubble
                                key={msg.id}
                                side={msg.side}
                                text={msg.text}
                                isFinal={msg.isFinal}
                                sourceType={msg.sourceType}
                                attachments={msg.attachments}
                                sent={msg.sent}
                            />
                        ))}
                    </div>
                </div>
            </section>
        </div>
    );
}
