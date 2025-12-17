import React, { useMemo } from 'react';
import CodeSnippet from './CodeSnippet';
import { parseFencedCode } from '../utils/parseFencedCode';

function ChatBubble({ text, side = 'left', isFinal = true, attachments = [] }) {
    const bubbleSide = side === 'right' ? 'right' : 'left';
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const segments = useMemo(() => parseFencedCode(text || ''), [text]);

    const renderSegment = (segment, index) => {
        if (segment.type === 'code') {
            return (
                <CodeSnippet
                    key={`code-${index}`}
                    code={segment.code}
                    language={segment.language}
                />
            );
        }
        if (segment.type === 'error') {
            return (
                <span key={`error-${index}`} className="code-snippet-error">
                    {segment.text}
                </span>
            );
        }
        return (
            <span key={`text-${index}`} className="chat-bubble-text">
                {segment.text}
            </span>
        );
    };

    return (
        <div className={`chat-bubble ${bubbleSide}`} data-final={isFinal ? 'true' : 'false'}>
            {hasAttachments && (
                <div className="chat-bubble-attachments">
                    {attachments.map((att) => (
                        <img
                            key={att.id || att.name}
                            className="chat-bubble-attachment"
                            src={att.dataUrl || att.data}
                            alt={att.name || 'attachment'}
                        />
                    ))}
                </div>
            )}
            <div className="chat-bubble-content">
                {segments.map((segment, index) => renderSegment(segment, index))}
            </div>
        </div>
    );
}

export default ChatBubble;
