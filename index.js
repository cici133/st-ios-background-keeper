import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { debounce, delay } from '../../../utils.js';
import { registerSlashCommand } from '../../../slash-commands.js';

const EXTENSION_NAME = getExtensionNameFromImportUrl();
const SETTINGS_KEY = 'iosBackgroundKeeper';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    enterPipOnStart: true,
    autoResume: true,
    wakeLock: false,
    showPreview: false,
    showDiagnostics: true,
    sourceMode: 'auto',
    frameRate: 1,
});

const state = {
    video: null,
    canvas: null,
    context: null,
    stream: null,
    streamFrameRate: null,
    drawTimer: null,
    recoveryTimer: null,
    heartbeatTimer: null,
    wakeLock: null,
    startedAt: 0,
    lastHeartbeatAt: 0,
    maxHeartbeatDriftMs: 0,
    lastError: '',
    lastWarning: '',
    frame: 0,
    recordedUrl: '',
    recordedFrameRate: null,
    recordedMimeType: '',
};

function getExtensionNameFromImportUrl() {
    const fallback = 'third-party/st-ios-background-keeper';

    try {
        const marker = '/scripts/extensions/';
        const path = new URL(import.meta.url).pathname.replace(/\\/g, '/');
        const markerIndex = path.indexOf(marker);
        if (markerIndex === -1) return fallback;

        const relativePath = decodeURIComponent(path.slice(markerIndex + marker.length));
        const parts = relativePath.split('/').filter(Boolean);
        if (parts[0] === 'third-party' && parts[1]) {
            return `third-party/${parts[1]}`;
        }

        return parts[0] || fallback;
    } catch {
        return fallback;
    }
}

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = {};
    }

    const settings = extension_settings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = value;
        }
    }

    settings.enabled = Boolean(settings.enabled);
    settings.enterPipOnStart = Boolean(settings.enterPipOnStart);
    settings.autoResume = Boolean(settings.autoResume);
    settings.wakeLock = Boolean(settings.wakeLock);
    settings.showPreview = Boolean(settings.showPreview);
    settings.showDiagnostics = Boolean(settings.showDiagnostics);
    settings.sourceMode = normalizeSourceMode(settings.sourceMode);
    settings.frameRate = clampFrameRate(settings.frameRate);

    return settings;
}

function normalizeSourceMode(value) {
    return ['auto', 'recorded', 'stream'].includes(value) ? value : DEFAULT_SETTINGS.sourceMode;
}

function clampFrameRate(value) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return DEFAULT_SETTINGS.frameRate;
    return Math.min(5, Math.max(1, parsed));
}

function saveSettings() {
    saveSettingsDebounced();
}

function getRoot() {
    return document.getElementById('ios_keeper_root');
}

function setMessage(message, tone = '') {
    const element = document.getElementById('ios_keeper_message');
    if (!element) return;
    element.textContent = message || '';
    element.dataset.tone = tone;
}

function setBadge(label, stateName = 'stopped') {
    const badge = document.getElementById('ios_keeper_badge');
    if (!badge) return;
    badge.textContent = label;
    badge.dataset.state = stateName;
}

function setLastError(error) {
    state.lastError = normalizeError(error);
    state.lastWarning = '';
    setBadge('Error', 'error');
    setMessage(state.lastError, 'error');
    updateDiagnostics();
}

function setLastWarning(message) {
    state.lastWarning = message || '';
    state.lastError = '';
    setBadge('Warning', 'warning');
    setMessage(state.lastWarning, 'warning');
    updateDiagnostics();
}

function normalizeError(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return error.message || String(error);
}

function detectIOS() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    return /iPad|iPhone|iPod/.test(platform)
        || (/Macintosh/.test(platform) && navigator.maxTouchPoints > 1)
        || /\b(iPad|iPhone|iPod)\b/.test(ua);
}

function detectStandalone() {
    return window.navigator.standalone === true
        || window.matchMedia?.('(display-mode: standalone)')?.matches === true;
}

function getSupportReport() {
    const video = state.video;
    const webkitElementPip = Boolean(
        video
        && typeof video.webkitSupportsPresentationMode === 'function'
        && video.webkitSupportsPresentationMode('picture-in-picture'),
    );

    return {
        iOS: detectIOS(),
        homeScreen: detectStandalone(),
        canvasStream: typeof HTMLCanvasElement !== 'undefined'
            && typeof HTMLCanvasElement.prototype.captureStream === 'function',
        standardPip: Boolean(document.pictureInPictureEnabled)
            && typeof HTMLVideoElement !== 'undefined'
            && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function',
        webkitPipApi: typeof HTMLVideoElement !== 'undefined'
            && typeof HTMLVideoElement.prototype.webkitSetPresentationMode === 'function',
        webkitElementPip,
        mediaRecorder: 'MediaRecorder' in window,
        recordedMimeType: getBestRecorderMimeType() || ('MediaRecorder' in window ? 'default' : ''),
        mediaSession: 'mediaSession' in navigator,
        wakeLock: Boolean(navigator.wakeLock?.request),
    };
}

function formatBool(value) {
    return value ? 'yes' : 'no';
}

function formatDuration(ms) {
    if (!ms) return '0s';
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (!minutes) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
}

function getBestRecorderMimeType() {
    if (!('MediaRecorder' in window) || typeof MediaRecorder.isTypeSupported !== 'function') {
        return '';
    }

    const candidates = [
        'video/mp4;codecs=avc1.42E01E',
        'video/mp4;codecs=h264',
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
    ];

    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function getVideoSourceLabel() {
    if (state.recordedUrl && state.video?.src === state.recordedUrl) {
        return `recorded blob${state.recordedMimeType ? ` (${state.recordedMimeType})` : ''}`;
    }

    if (state.stream && state.video?.srcObject === state.stream) {
        return 'canvas stream';
    }

    return 'none';
}

function shouldUseRecordedSource() {
    const settings = getSettings();
    if (settings.sourceMode === 'stream') return false;
    if (settings.sourceMode === 'recorded') return true;
    return detectIOS() || detectStandalone();
}

function updateDiagnostics() {
    const container = document.getElementById('ios_keeper_diagnostics');
    if (!container) return;

    const report = getSupportReport();
    const video = state.video;
    const stream = state.stream;
    const rows = [
        ['iOS detected', formatBool(report.iOS)],
        ['Home Screen mode', formatBool(report.homeScreen)],
        ['Canvas stream', formatBool(report.canvasStream)],
        ['Video source', getVideoSourceLabel()],
        ['MediaRecorder', formatBool(report.mediaRecorder)],
        ['Recorded MIME', report.recordedMimeType || 'none'],
        ['WebKit PiP API', formatBool(report.webkitPipApi)],
        ['Element PiP ready', formatBool(report.webkitElementPip)],
        ['Standard PiP API', formatBool(report.standardPip)],
        ['Video paused', video ? formatBool(video.paused) : 'none'],
        ['PiP active', formatBool(isInPictureInPicture())],
        ['Stream tracks', stream ? String(stream.getVideoTracks().length) : '0'],
        ['Video size', video?.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : 'none'],
        ['Runtime', state.startedAt ? formatDuration(Date.now() - state.startedAt) : '0s'],
        ['Max timer drift', `${Math.round(state.maxHeartbeatDriftMs)}ms`],
        ['Wake lock API', formatBool(report.wakeLock)],
        ['Wake lock held', formatBool(Boolean(state.wakeLock))],
        ['MediaSession', formatBool(report.mediaSession)],
        ['Last warning', state.lastWarning || 'none'],
        ['Last error', state.lastError || 'none'],
    ];

    container.replaceChildren();
    for (const [key, value] of rows) {
        const keyElement = document.createElement('div');
        keyElement.className = 'ios-keeper-key';
        keyElement.textContent = key;

        const valueElement = document.createElement('div');
        valueElement.className = 'ios-keeper-value';
        valueElement.textContent = value;

        container.append(keyElement, valueElement);
    }
}

function syncUI() {
    const settings = getSettings();
    $('#ios_keeper_enabled').prop('checked', settings.enabled);
    $('#ios_keeper_enter_pip_on_start').prop('checked', settings.enterPipOnStart);
    $('#ios_keeper_auto_resume').prop('checked', settings.autoResume);
    $('#ios_keeper_wake_lock').prop('checked', settings.wakeLock);
    $('#ios_keeper_show_preview').prop('checked', settings.showPreview);
    $('#ios_keeper_show_diagnostics').prop('checked', settings.showDiagnostics);
    $('#ios_keeper_source_mode').val(settings.sourceMode);
    $('#ios_keeper_frame_rate').val(settings.frameRate);

    const root = getRoot();
    if (root) {
        root.dataset.preview = String(settings.showPreview);
        root.dataset.diagnostics = String(settings.showDiagnostics);
    }

    refreshRuntimeStatus();
}

function updateBooleanSetting(key, value) {
    getSettings()[key] = Boolean(value);
    saveSettings();
    syncUI();
}

function createPosterUrl() {
    const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">',
        '<rect width="320" height="180" fill="#101316"/>',
        '<circle cx="160" cy="90" r="34" fill="#47b3ff" opacity="0.85"/>',
        '<text x="160" y="98" text-anchor="middle" font-size="26" font-family="Arial, sans-serif" fill="#fff">ST</text>',
        '</svg>',
    ].join('');
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function ensureVideoElement() {
    if (state.video) return state.video;

    const mount = document.getElementById('ios_keeper_video_mount') || document.body;
    const video = document.createElement('video');
    video.id = 'ios_keeper_video';
    video.className = 'ios-keeper-video';
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.controls = true;
    video.autoplay = false;
    video.loop = true;
    video.preload = 'auto';
    video.poster = createPosterUrl();
    video.disableRemotePlayback = true;
    video.disablePictureInPicture = false;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('x-webkit-airplay', 'deny');

    mount.append(video);
    state.video = video;
    bindVideoEvents(video);
    return video;
}

function bindVideoEvents(video) {
    const refreshEvents = [
        'play',
        'pause',
        'loadedmetadata',
        'stalled',
        'waiting',
        'canplay',
        'enterpictureinpicture',
        'leavepictureinpicture',
        'webkitpresentationmodechanged',
    ];

    for (const eventName of refreshEvents) {
        video.addEventListener(eventName, () => {
            refreshRuntimeStatus();
            updateDiagnostics();
        });
    }

    video.addEventListener('error', () => {
        const detail = video.error ? `media error ${video.error.code}` : 'media error';
        setLastError(detail);
    });
}

function ensureCanvas() {
    if (state.canvas) return state.canvas;

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    canvas.hidden = true;
    state.canvas = canvas;
    state.context = canvas.getContext('2d');
    return canvas;
}

function drawFrame() {
    const canvas = ensureCanvas();
    const context = state.context;
    if (!context) return;

    const width = canvas.width;
    const height = canvas.height;
    const now = new Date();
    const pulse = (state.frame % 24) / 24;
    const barWidth = 48 + Math.round(160 * pulse);

    context.fillStyle = '#101316';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#1d2a32';
    context.fillRect(0, height - 28, width, 28);
    context.fillStyle = '#47b3ff';
    context.fillRect(28, height - 18, barWidth, 8);
    context.fillStyle = '#ffffff';
    context.font = '600 24px Arial, sans-serif';
    context.textAlign = 'center';
    context.fillText('SillyTavern', width / 2, 78);
    context.font = '16px Arial, sans-serif';
    context.fillText('Background Keeper', width / 2, 104);
    context.font = '12px Arial, sans-serif';
    context.fillText(now.toLocaleTimeString(), width / 2, 132);

    state.frame += 1;
}

function startDrawing(frameRate) {
    stopDrawing();
    drawFrame();
    const interval = Math.max(250, Math.round(1000 / frameRate));
    state.drawTimer = setInterval(drawFrame, interval);
}

function stopDrawing() {
    if (state.drawTimer) {
        clearInterval(state.drawTimer);
        state.drawTimer = null;
    }
}

async function ensureCanvasStream() {
    const settings = getSettings();
    const frameRate = clampFrameRate(settings.frameRate);
    const video = ensureVideoElement();
    const canvas = ensureCanvas();

    if (typeof canvas.captureStream !== 'function') {
        throw new Error('Canvas video stream is not supported by this browser.');
    }

    if (state.stream && state.streamFrameRate === frameRate && video.srcObject === state.stream) {
        return state.stream;
    }

    stopStream();
    revokeRecordedUrl();
    video.removeAttribute('src');
    startDrawing(frameRate);

    const stream = canvas.captureStream(frameRate);
    if (!stream || stream.getVideoTracks().length === 0) {
        throw new Error('Canvas stream did not create a video track.');
    }

    state.stream = stream;
    state.streamFrameRate = frameRate;
    video.srcObject = stream;
    await waitForMetadata(video, 1400);
    return stream;
}

async function ensureKeeperVideoSource() {
    if (shouldUseRecordedSource()) {
        try {
            return await ensureRecordedVideo();
        } catch (error) {
            if (getSettings().sourceMode === 'recorded') {
                throw error;
            }

            state.lastWarning = `Recorded video failed, falling back to live stream: ${normalizeError(error)}`;
        }
    }

    return ensureCanvasStream();
}

async function ensureRecordedVideo() {
    const settings = getSettings();
    const frameRate = clampFrameRate(settings.frameRate);
    const video = ensureVideoElement();

    if (state.recordedUrl && state.recordedFrameRate === frameRate && video.src === state.recordedUrl) {
        await waitForMetadata(video, 1400);
        return state.recordedUrl;
    }

    if (typeof HTMLCanvasElement === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
        throw new Error('Canvas captureStream is required to prepare a recorded video.');
    }

    if (!('MediaRecorder' in window)) {
        throw new Error('MediaRecorder is not available in this browser.');
    }

    const mimeType = getBestRecorderMimeType();
    stopStream();
    revokeRecordedUrl();

    const blob = await recordKeeperBlob(frameRate, mimeType);
    const url = URL.createObjectURL(blob);

    state.recordedUrl = url;
    state.recordedFrameRate = frameRate;
    state.recordedMimeType = blob.type || mimeType;

    video.pause();
    video.srcObject = null;
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.defaultMuted = true;
    video.load();

    await waitForMetadata(video, 1800);
    return url;
}

async function recordKeeperBlob(frameRate, mimeType) {
    const canvas = ensureCanvas();
    startDrawing(Math.max(2, frameRate));

    const stream = canvas.captureStream(Math.max(2, frameRate));
    const chunks = [];

    try {
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

        const stopped = new Promise((resolve, reject) => {
            recorder.ondataavailable = event => {
                if (event.data && event.data.size > 0) {
                    chunks.push(event.data);
                }
            };

            recorder.onerror = event => {
                reject(event.error || new Error('MediaRecorder failed.'));
            };

            recorder.onstop = () => {
                if (chunks.length === 0) {
                    reject(new Error('MediaRecorder produced an empty video.'));
                    return;
                }

                const blobType = mimeType || chunks[0]?.type || 'video/mp4';
                resolve(new Blob(chunks, { type: blobType }));
            };
        });

        recorder.start(100);
        await delay(1400);

        if (recorder.state !== 'inactive') {
            recorder.stop();
        }

        return await stopped;
    } finally {
        for (const track of stream.getTracks()) {
            track.stop();
        }
        stopDrawing();
    }
}

function stopStream() {
    if (state.stream) {
        for (const track of state.stream.getTracks()) {
            track.stop();
        }
    }
    state.stream = null;
    state.streamFrameRate = null;

    if (state.video) {
        state.video.srcObject = null;
    }
}

function revokeRecordedUrl() {
    if (!state.recordedUrl) return;

    try {
        URL.revokeObjectURL(state.recordedUrl);
    } catch {
        // Ignore cleanup errors for stale blob URLs.
    }

    state.recordedUrl = '';
    state.recordedFrameRate = null;
    state.recordedMimeType = '';
}

function waitForMetadata(video, timeoutMs) {
    if (video.readyState >= 1) return Promise.resolve();

    return new Promise((resolve) => {
        let timeout = null;
        const cleanup = () => {
            video.removeEventListener('loadedmetadata', onLoaded);
            if (timeout) clearTimeout(timeout);
        };
        const onLoaded = () => {
            cleanup();
            resolve();
        };

        video.addEventListener('loadedmetadata', onLoaded, { once: true });
        timeout = setTimeout(() => {
            cleanup();
            resolve();
        }, timeoutMs);
    });
}

async function playVideo() {
    const video = ensureVideoElement();
    video.muted = true;
    video.defaultMuted = true;
    const playPromise = video.play();
    if (playPromise && typeof playPromise.then === 'function') {
        await playPromise;
    }
}

function isInPictureInPicture() {
    const video = state.video;
    if (!video) return false;
    return document.pictureInPictureElement === video
        || video.webkitPresentationMode === 'picture-in-picture';
}

async function enterPictureInPicture() {
    const settings = getSettings();
    settings.enabled = true;
    saveSettings();
    syncUI();

    const video = ensureVideoElement();
    if (!state.stream) {
        throw new Error('Keeper video is not ready. Tap Start Video first, wait for "Running", then tap PiP.');
    }

    if (video.paused) {
        throw new Error('Keeper video is not playing. Tap Start Video first, then tap PiP.');
    }

    if (video.readyState < 1) {
        throw new Error('Keeper video is still preparing. Wait a second, then tap PiP again.');
    }

    if (isInPictureInPicture()) {
        refreshRuntimeStatus();
        return;
    }

    const report = getSupportReport();
    try {
        if (
            typeof video.webkitSupportsPresentationMode === 'function'
            && typeof video.webkitSetPresentationMode === 'function'
            && video.webkitSupportsPresentationMode('picture-in-picture')
        ) {
            video.webkitSetPresentationMode('picture-in-picture');
            state.lastError = '';
            state.lastWarning = '';
            setBadge('PiP', 'pip');
            setMessage('PiP active. Keep the floating video open.', 'ok');
            updateDiagnostics();
            return;
        }

        if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
            await video.requestPictureInPicture();
            state.lastError = '';
            state.lastWarning = '';
            setBadge('PiP', 'pip');
            setMessage('PiP active. Keep the floating video open.', 'ok');
            updateDiagnostics();
            return;
        }

        throw new Error('Picture in Picture is not available for this video element.');
    } catch (error) {
        const suffix = report.homeScreen
            ? ' Home Screen mode may block PiP on this iOS version; try opening SillyTavern in Safari.'
            : '';
        throw new Error(`${normalizeError(error)}${suffix}`);
    }
}

async function exitPictureInPicture() {
    const video = state.video;
    if (!video) return;

    try {
        if (document.pictureInPictureElement === video && typeof document.exitPictureInPicture === 'function') {
            await document.exitPictureInPicture();
        } else if (
            video.webkitPresentationMode === 'picture-in-picture'
            && typeof video.webkitSetPresentationMode === 'function'
        ) {
            video.webkitSetPresentationMode('inline');
        }
    } catch (error) {
        console.warn('[iOS Background Keeper] Could not exit Picture in Picture:', error);
    }
}

async function enterNativeFullscreen() {
    const video = ensureVideoElement();

    if (!state.stream && !state.recordedUrl) {
        throw new Error('Keeper video is not ready. Tap Start Video first.');
    }

    if (video.paused) {
        throw new Error('Keeper video is not playing. Tap Start Video first.');
    }

    if (typeof video.webkitEnterFullscreen === 'function') {
        video.webkitEnterFullscreen();
        setMessage('Opened native video controls. If iOS shows a PiP icon, tap it there.', 'info');
        return;
    }

    if (typeof video.requestFullscreen === 'function') {
        await video.requestFullscreen();
        setMessage('Opened fullscreen video controls. If iOS shows a PiP icon, tap it there.', 'info');
        return;
    }

    throw new Error('Native fullscreen is not available for this video element.');
}

async function startKeeper({ enterPip = true } = {}) {
    const settings = getSettings();
    settings.enabled = true;
    saveSettings();
    syncUI();

    setBadge('Starting', 'warning');
    setMessage('Starting keeper video...', 'info');

    try {
        await ensureKeeperVideoSource();
        await playVideo();
        state.startedAt = state.startedAt || Date.now();
        state.lastError = '';
        state.lastWarning = '';
        startRecoveryTimer();
        startHeartbeatTimer();
        setupMediaSession();

        if (settings.wakeLock) {
            void requestWakeLock();
        }

        if (enterPip) {
            setMessage('Video is running. On iOS, tap the PiP button once more to enter Picture in Picture.', 'info');
        }

        refreshRuntimeStatus();
    } catch (error) {
        setLastError(error);
    }
}

async function stopKeeper({ disarm = true } = {}) {
    if (disarm) {
        getSettings().enabled = false;
        saveSettings();
    }

    stopRecoveryTimer();
    stopHeartbeatTimer();
    await releaseWakeLock();
    await exitPictureInPicture();

    if (state.video) {
        state.video.pause();
    }

    stopStream();
    revokeRecordedUrl();
    if (state.video) {
        state.video.removeAttribute('src');
        state.video.load();
    }
    stopDrawing();
    state.startedAt = 0;
    state.maxHeartbeatDriftMs = 0;
    state.lastError = '';
    state.lastWarning = '';
    setMediaSessionState('none');
    syncUI();
    setBadge('Stopped', 'stopped');
    setMessage('Stopped.', 'info');
    updateDiagnostics();
}

function startRecoveryTimer() {
    stopRecoveryTimer();
    state.recoveryTimer = setInterval(() => {
        void recoveryTick();
    }, 5000);
}

function stopRecoveryTimer() {
    if (state.recoveryTimer) {
        clearInterval(state.recoveryTimer);
        state.recoveryTimer = null;
    }
}

async function recoveryTick() {
    const settings = getSettings();
    if (!settings.enabled || !state.video) return;

    if (settings.autoResume && state.video.paused) {
        try {
            await playVideo();
        } catch (error) {
            state.lastWarning = normalizeError(error);
        }
    }

    if (settings.wakeLock && document.visibilityState === 'visible') {
        void requestWakeLock();
    }

    refreshRuntimeStatus();
    updateDiagnostics();
}

function startHeartbeatTimer() {
    stopHeartbeatTimer();
    state.lastHeartbeatAt = Date.now();
    state.heartbeatTimer = setInterval(() => {
        const now = Date.now();
        const drift = Math.max(0, now - state.lastHeartbeatAt - 1000);
        state.maxHeartbeatDriftMs = Math.max(state.maxHeartbeatDriftMs, drift);
        state.lastHeartbeatAt = now;
        updateDiagnostics();
    }, 1000);
}

function stopHeartbeatTimer() {
    if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
    }
}

async function requestWakeLock() {
    if (!getSettings().wakeLock || document.visibilityState !== 'visible') return;
    if (!navigator.wakeLock?.request || state.wakeLock) return;

    try {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => {
            state.wakeLock = null;
            updateDiagnostics();
        }, { once: true });
    } catch (error) {
        state.lastWarning = `Wake lock failed: ${normalizeError(error)}`;
    } finally {
        updateDiagnostics();
    }
}

async function releaseWakeLock() {
    if (!state.wakeLock) return;
    const lock = state.wakeLock;
    state.wakeLock = null;
    try {
        await lock.release();
    } catch {
        // Already released by the browser.
    }
}

function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;

    try {
        if ('MediaMetadata' in window) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: 'SillyTavern Keeper',
                artist: 'SillyTavern',
                album: 'iOS Background Keeper',
            });
        }

        navigator.mediaSession.setActionHandler?.('play', () => {
            void startKeeper({ enterPip: false });
        });
        navigator.mediaSession.setActionHandler?.('pause', () => {
            state.video?.pause();
            refreshRuntimeStatus();
        });
        setMediaSessionState('playing');
    } catch (error) {
        console.warn('[iOS Background Keeper] MediaSession setup failed:', error);
    }
}

function setMediaSessionState(value) {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.playbackState = value;
    } catch {
        // Some browsers reject nonstandard state changes.
    }
}

function refreshRuntimeStatus() {
    const settings = getSettings();
    const video = state.video;
    const report = getSupportReport();

    const root = getRoot();
    if (root) {
        root.dataset.preview = String(settings.showPreview);
        root.dataset.diagnostics = String(settings.showDiagnostics);
    }

    if (isInPictureInPicture()) {
        setBadge('PiP', 'pip');
        if (!state.lastWarning && !state.lastError) {
            setMessage('PiP active. Keep the floating video open.', 'ok');
        }
        setMediaSessionState('playing');
    } else if (video && !video.paused && settings.enabled) {
        setBadge('Running', 'running');
        if (!state.lastWarning && !state.lastError) {
            const message = report.homeScreen
                ? 'Running. If PiP fails, use a Safari tab instead of Home Screen mode.'
                : 'Running. Press PiP before switching apps.';
            setMessage(message, 'info');
        }
        setMediaSessionState('playing');
    } else if (settings.enabled) {
        setBadge('Armed', 'warning');
        if (!state.lastWarning && !state.lastError) {
            setMessage('Armed. Press Start PiP to activate.', 'info');
        }
        setMediaSessionState('paused');
    } else {
        setBadge('Stopped', 'stopped');
        if (!state.lastWarning && !state.lastError) {
            setMessage('Stopped.', 'info');
        }
        setMediaSessionState('none');
    }

    const stopButton = document.getElementById('ios_keeper_stop');
    if (stopButton) {
        stopButton.disabled = !settings.enabled && !state.stream;
    }

    if (state.lastError) {
        setBadge('Error', 'error');
        setMessage(state.lastError, 'error');
    } else if (state.lastWarning) {
        setBadge('Warning', 'warning');
        setMessage(state.lastWarning, 'warning');
    }

    updateDiagnostics();
}

function bindSettingsControls() {
    $('#ios_keeper_enabled').on('change', async function () {
        if (this.checked) {
            getSettings().enabled = true;
            saveSettings();
            syncUI();
            await startKeeper({ enterPip: false });
        } else {
            await stopKeeper({ disarm: true });
        }
    });

    $('#ios_keeper_start').on('click', () => {
        if (getSettings().enterPipOnStart && state.stream && state.video && !state.video.paused) {
            void enterPictureInPicture().catch(setLastError);
            return;
        }

        void startKeeper({ enterPip: getSettings().enterPipOnStart });
    });

    $('#ios_keeper_pip').on('click', async () => {
        try {
            await enterPictureInPicture();
        } catch (error) {
            setLastError(error);
        }
    });

    $('#ios_keeper_fullscreen').on('click', async () => {
        try {
            await enterNativeFullscreen();
        } catch (error) {
            setLastError(error);
        }
    });

    $('#ios_keeper_stop').on('click', () => {
        void stopKeeper({ disarm: true });
    });

    $('#ios_keeper_refresh').on('click', () => {
        refreshRuntimeStatus();
    });

    $('#ios_keeper_enter_pip_on_start').on('change', function () {
        updateBooleanSetting('enterPipOnStart', this.checked);
    });

    $('#ios_keeper_auto_resume').on('change', function () {
        updateBooleanSetting('autoResume', this.checked);
    });

    $('#ios_keeper_wake_lock').on('change', function () {
        updateBooleanSetting('wakeLock', this.checked);
        if (this.checked) {
            void requestWakeLock();
        } else {
            void releaseWakeLock();
        }
    });

    $('#ios_keeper_show_preview').on('change', function () {
        updateBooleanSetting('showPreview', this.checked);
    });

    $('#ios_keeper_show_diagnostics').on('change', function () {
        updateBooleanSetting('showDiagnostics', this.checked);
    });

    $('#ios_keeper_source_mode').on('change', function () {
        const settings = getSettings();
        settings.sourceMode = normalizeSourceMode(this.value);
        saveSettings();

        if (settings.enabled) {
            void startKeeper({ enterPip: false });
        } else {
            syncUI();
        }
    });

    $('#ios_keeper_frame_rate').on('input', debounce(function () {
        const settings = getSettings();
        settings.frameRate = clampFrameRate(this.value);
        this.value = settings.frameRate;
        saveSettings();

        if (settings.enabled && (state.stream || state.recordedUrl)) {
            void startKeeper({ enterPip: false });
        } else {
            syncUI();
        }
    }, 250));
}

function bindPageLifecycle() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            void recoveryTick();
        } else {
            void releaseWakeLock();
        }
        refreshRuntimeStatus();
    });

    window.addEventListener('pageshow', () => {
        void recoveryTick();
    });
}

function buildStatusSummary() {
    const report = getSupportReport();
    const status = isInPictureInPicture()
        ? 'PiP'
        : state.video && !state.video.paused
            ? 'running'
            : getSettings().enabled
                ? 'armed'
                : 'stopped';
    return [
        `status=${status}`,
        `ios=${formatBool(report.iOS)}`,
        `homeScreen=${formatBool(report.homeScreen)}`,
        `canvasStream=${formatBool(report.canvasStream)}`,
        `webkitPip=${formatBool(report.webkitElementPip || report.webkitPipApi)}`,
        `error=${state.lastError || 'none'}`,
    ].join(' ');
}

function getOrCreateSettingsContainer() {
    const existing = document.getElementById('ios_keeper_container');
    if (existing) return existing;

    const container = document.createElement('div');
    container.id = 'ios_keeper_container';
    container.className = 'extension_container';

    const idleContainer = document.getElementById('idle_container');
    if (idleContainer?.parentElement) {
        idleContainer.insertAdjacentElement('afterend', container);
        return container;
    }

    const silenceContainer = document.getElementById('silence_container');
    if (silenceContainer?.parentElement) {
        silenceContainer.insertAdjacentElement('afterend', container);
        return container;
    }

    const settingsColumn = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    settingsColumn?.append(container);
    return container;
}

function revealSettingsPanel() {
    const drawerContent = document.getElementById('rm_extensions_block');
    if (drawerContent?.classList.contains('closedDrawer')) {
        document.querySelector('#extensions-settings-button .drawer-toggle')?.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
        }));
    }

    setTimeout(() => {
        getRoot()?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
}

function addWandMenuButton() {
    if (document.getElementById('ios_keeper_wand_button')) return;

    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;

    const button = document.createElement('div');
    button.id = 'ios_keeper_wand_button';
    button.className = 'list-group-item flex-container flexGap5';
    button.title = 'Open iOS Background Keeper';
    button.innerHTML = `
        <div class="fa-solid fa-window-restore extensionsMenuExtensionButton"></div>
        <span>iOS Background Keeper</span>
    `;
    button.addEventListener('click', () => {
        $('#extensionsMenu').hide();
        revealSettingsPanel();
    });

    const anchor = document.getElementById('tts_wand_container') ?? menu.lastElementChild;
    if (anchor?.parentElement === menu) {
        anchor.insertAdjacentElement('afterend', button);
    } else {
        menu.append(button);
    }
}

function renderInitializationError(error) {
    console.error('[iOS Background Keeper] Initialization failed:', error);

    const container = getOrCreateSettingsContainer();
    const root = document.createElement('div');
    root.id = 'ios_keeper_root';
    root.className = 'ios-keeper-root';

    const drawer = document.createElement('div');
    drawer.className = 'inline-drawer';
    drawer.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>iOS Background Keeper</b>
            <span class="ios-keeper-badge" data-state="error">Error</span>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="ios-keeper-message"></div>
        </div>
    `;

    drawer.querySelector('.ios-keeper-message').textContent = normalizeError(error) || 'Initialization failed.';
    root.append(drawer);
    container.append(root);
    addWandMenuButton();
}

function slashCommand(_args, value = '') {
    const command = String(value || '').trim().toLowerCase();

    if (command === 'stop') {
        void stopKeeper({ disarm: true });
        return 'iOS Background Keeper stopping.';
    }

    if (command === 'status') {
        refreshRuntimeStatus();
        return buildStatusSummary();
    }

    if (command === 'inline') {
        void startKeeper({ enterPip: false });
        return 'iOS Background Keeper starting inline.';
    }

    void startKeeper({ enterPip: true });
    return 'iOS Background Keeper starting.';
}

async function init() {
    const container = $(getOrCreateSettingsContainer());

    try {
        const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'panel');
        container.append(html);
        getSettings();
        syncUI();
        bindSettingsControls();
        bindPageLifecycle();
        addWandMenuButton();
        updateDiagnostics();
    } catch (error) {
        renderInitializationError(error);
        return;
    }

    try {
        registerSlashCommand(
            'ios-keeper',
            slashCommand,
            [],
            '- starts/stops iOS Background Keeper. Use "stop", "inline", or "status".',
            true,
            true,
        );
    } catch (error) {
        console.warn('[iOS Background Keeper] Slash command registration failed:', error);
    }
}

jQuery(() => {
    void init();
});
