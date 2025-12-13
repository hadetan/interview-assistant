import React from 'react';

function ChatBubble({ text, side = 'left', isFinal = true }) {
    const bubbleSide = side === 'right' ? 'right' : 'left';
    return (
        <div className={`chat-bubble ${bubbleSide}`} data-final={isFinal ? 'true' : 'false'}>
            {text || ''}
        </div>
    );
}

export default ChatBubble;
