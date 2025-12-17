import React, { useMemo } from 'react';
import { highlightCode } from '../utils/highlightCode';
import 'highlight.js/styles/github-dark.css';

function CodeSnippet({ code = '', language }) {
    const { html, language: detectedLanguage } = useMemo(
        () => highlightCode(code, language),
        [code, language]
    );

    return (
        <div className="code-snippet" data-language={detectedLanguage}>
            {detectedLanguage && (
                <span className="code-snippet-label">{detectedLanguage}</span>
            )}
            <pre>
                <code dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
        </div>
    );
}

export default CodeSnippet;
