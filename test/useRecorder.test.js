const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const ReactDOMClient = require('react-dom/client');
const { JSDOM } = require('jsdom');

const originalGlobals = {
    window: global.window,
    document: global.document,
    navigator: global.navigator,
    MediaRecorder: global.MediaRecorder,
    MediaStream: global.MediaStream,
    electronAPI: global.electronAPI
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/'
});

global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.IS_REACT_ACT_ENVIRONMENT = true;
window.IS_REACT_ACT_ENVIRONMENT = true;

function createTrack(kind) {
    return {
        kind,
        readyState: 'live',
        stopCalled: false,
        stop() {
            this.readyState = 'ended';
            this.stopCalled = true;
        }
    };
}

class FakeMediaStream {
    constructor(tracks = []) {
        this.id = `stream-${Math.random().toString(36).slice(2, 10)}`;
        this._tracks = tracks.slice();
    }

    getTracks() {
        return this._tracks.slice();
    }

    getAudioTracks() {
        return this._tracks.filter((track) => track.kind === 'audio');
    }

    getVideoTracks() {
        return this._tracks.filter((track) => track.kind === 'video');
    }
}

global.MediaStream = FakeMediaStream;
window.MediaStream = FakeMediaStream;

let userMediaCalls = [];
let micStreamInstance = null;

function createSystemStream() {
    const audioTrack = createTrack('audio');
    const videoTrack = createTrack('video');
    return new FakeMediaStream([audioTrack, videoTrack]);
}

function createMicStream() {
    const audioTrack = createTrack('audio');
    return new FakeMediaStream([audioTrack]);
}

navigator.mediaDevices = {
    getUserMedia: async (constraints) => {
        userMediaCalls.push(constraints);
        if (constraints && constraints.audio === true && constraints.video === false) {
            if (!micStreamInstance) {
                micStreamInstance = createMicStream();
            }
            return micStreamInstance;
        }
        if (constraints && constraints.audio && typeof constraints.audio === 'object') {
            return createSystemStream();
        }
        throw new Error('Unexpected getUserMedia constraints');
    }
};

class FakeMediaRecorder extends (window.EventTarget || global.EventTarget) {
    constructor(stream, options = {}) {
        super();
        this.stream = stream;
        this.options = options;
        this.mimeType = options.mimeType || 'audio/webm';
        this.state = 'inactive';
    }

    start() {
        this.state = 'recording';
    }

    stop() {
        if (this.state === 'inactive') {
            return;
        }
        this.state = 'inactive';
        const dataEvent = new window.Event('dataavailable');
        dataEvent.data = {
            size: 1,
            arrayBuffer: async () => new ArrayBuffer(1)
        };
        this.dispatchEvent(dataEvent);
        const stopEvent = new window.Event('stop');
        this.dispatchEvent(stopEvent);
    }
}

window.MediaRecorder = FakeMediaRecorder;
global.MediaRecorder = FakeMediaRecorder;

const electronSources = [
    { id: 'source-1', name: 'Display 1' }
];

window.electronAPI = {
    getDesktopSources: async () => electronSources,
    transcription: {
        sendChunk: () => {}
    }
};

const useRecorderModulePromise = import('../src/hooks/useRecorder.js');

function resetMediaMocks() {
    userMediaCalls = [];
    micStreamInstance = null;
}

function createSessionApi() {
    const sessions = new Map();
    const streaming = new Set();

    return {
        getSessionId: (sourceType) => sessions.get(sourceType) || null,
        setStatus: () => {},
        startTranscriptionSession: async ({ sourceType }) => {
            const sessionId = `${sourceType}-session`;
            sessions.set(sourceType, sessionId);
            streaming.add(sourceType);
            return { sessionId };
        },
        attachTranscriptionEvents: () => {},
        clearTranscript: () => {},
        teardownSession: async () => {
            sessions.clear();
            streaming.clear();
        },
        isSourceStreaming: (sourceType) => streaming.has(sourceType),
        startSourceSession: async ({ sourceType }) => {
            const sessionId = `${sourceType}-session-${Math.random().toString(36).slice(2, 8)}`;
            sessions.set(sourceType, sessionId);
            streaming.add(sourceType);
            return { sessionId };
        },
        stopSourceSession: async ({ sourceType }) => {
            sessions.delete(sourceType);
            streaming.delete(sourceType);
            return { ok: true };
        }
    };
}

async function renderHook(options) {
    const { useRecorder } = await useRecorderModulePromise;
    const hookRef = { current: null };

    function Wrapper(props) {
        hookRef.current = useRecorder(props.options);
        return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    await act(async () => {
        root.render(React.createElement(Wrapper, { options }));
    });

    const unmount = async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
    };

    return { hookRef, unmount };
}

test('startRecording does not prewarm microphone stream', async () => {
    resetMediaMocks();
    const sessionApi = createSessionApi();
    const { hookRef, unmount } = await renderHook({
        chunkTimeslice: 50,
        platform: 'win32',
        preferredMimeType: null,
        sessionApi
    });

    await act(async () => {
        await hookRef.current.startRecording();
    });

    assert.equal(userMediaCalls.length, 1);
    const [systemConstraints] = userMediaCalls;
    assert.ok(systemConstraints.audio);
    assert.notEqual(systemConstraints.audio, true);

    await act(async () => {
        await hookRef.current.stopRecording();
    });

    await unmount();
});

test('microphone stream initializes on demand and reuses existing stream', async () => {
    resetMediaMocks();
    const sessionApi = createSessionApi();
    const { hookRef, unmount } = await renderHook({
        chunkTimeslice: 50,
        platform: 'win32',
        preferredMimeType: null,
        sessionApi
    });

    await act(async () => {
        await hookRef.current.startRecording();
    });

    assert.equal(userMediaCalls.length, 1);

    await act(async () => {
        const result = await hookRef.current.toggleMic();
        assert.equal(result.ok, true);
    });

    assert.equal(userMediaCalls.length, 2);
    const micConstraints = userMediaCalls[1];
    assert.equal(micConstraints.audio, true);
    assert.equal(micConstraints.video, false);

    await act(async () => {
        const result = await hookRef.current.toggleMic();
        assert.equal(result.ok, true);
    });

    assert.equal(userMediaCalls.length, 2);

    await act(async () => {
        const result = await hookRef.current.toggleMic();
        assert.equal(result.ok, true);
    });

    assert.equal(userMediaCalls.length, 2);

    await act(async () => {
        await hookRef.current.stopRecording();
    });

    await unmount();
});

test.after(() => {
    global.window = originalGlobals.window;
    global.document = originalGlobals.document;
    global.navigator = originalGlobals.navigator;
    global.MediaRecorder = originalGlobals.MediaRecorder;
    global.MediaStream = originalGlobals.MediaStream;
    if (originalGlobals.window) {
        originalGlobals.window.electronAPI = originalGlobals.electronAPI;
    } else {
        global.electronAPI = originalGlobals.electronAPI;
    }
    dom.window.close();
});
