import { MediaManager } from './media-manager.js';
import { VideoCapture } from './video-capture.js';
import { AudioRecorder } from './audio-recorder.js';
import { AudioPlayer } from './audio-player.js';
import { WebSocketClient } from './websocket-client.js';
import { PassiveMode } from './passive-mode.js';

class App {
    constructor() {
        this.mediaManager = new MediaManager();
        this.videoCapture = null;
        this.audioRecorder = new AudioRecorder();
        this.audioPlayer = new AudioPlayer();
        this.wsClient = null;
        this.passiveMode = null;
        this.isSessionActive = false;
        this.currentTopic = '';
        this.mode = 'idle'; // idle | passive | active
        this._facingMode = 'user'; // 'user' = front, 'environment' = back

        // DOM elements
        this.videoEl = document.getElementById('camera-preview');
        this.stopBtn = document.getElementById('btn-stop');
        this.statusEl = document.getElementById('status');
        this.statusDot = document.getElementById('status-dot');
        this.transcriptEl = document.getElementById('transcript');
        this.cameraPlaceholder = document.getElementById('camera-placeholder');
        this.topicCard = document.getElementById('topic-card');
        this.topicText = document.getElementById('topic-text');
        this.startConversationBtn = document.getElementById('btn-start-conversation');
        this.passiveControls = document.getElementById('passive-controls');
        this.frequencySelect = document.getElementById('frequency-select');
        this.countdownEl = document.getElementById('countdown-display');
        this.countdownLabelEl = document.getElementById('countdown-label');
        this.countdownTimerEl = document.getElementById('countdown-timer');
        this.activateBtn = document.getElementById('btn-activate');
        this.deactivateBtn = document.getElementById('btn-deactivate');
        this.flipCameraBtn = document.getElementById('btn-flip-camera');
        this.errorToast = document.getElementById('error-toast');
        this.errorToastMsg = document.getElementById('error-toast-msg');
        this._errorDismissTimer = null;

        this._bindEvents();
        // User must tap Activate — nothing runs automatically
    }

    _bindEvents() {
        this.stopBtn.addEventListener('click', () => this.stopSession());
        this.startConversationBtn.addEventListener('click', () => this.startSession(this.currentTopic));
        this.activateBtn.addEventListener('click', () => this._activate());
        this.deactivateBtn.addEventListener('click', () => this._deactivate());
        this.flipCameraBtn.addEventListener('click', () => this._flipCamera());
        document.getElementById('error-toast-close').addEventListener('click', () => this._hideError());

        this.frequencySelect.addEventListener('change', () => {
            const ms = parseInt(this.frequencySelect.value);
            if (this.passiveMode) {
                // Change event is a user gesture — unlock audio as a side effect (iOS)
                this.passiveMode.unlockAudio();
                this.passiveMode.setInterval(ms);
            }
        });
    }

    // ─── Activation / Deactivation ────────────────────────────────────────────

    async _activate() {
        this.activateBtn.disabled = true;
        this._setStatus('connecting', 'Requesting permissions...');

        // iOS Safari: AudioContext MUST be created synchronously inside a user-gesture
        // handler. Any await before this causes the context to stay suspended and
        // audio to be silently blocked — even on re-activation after a turn-off.
        let unlockedAudioCtx = null;
        try {
            unlockedAudioCtx = new AudioContext({ sampleRate: 24000 });
            if (unlockedAudioCtx.state === 'suspended') unlockedAudioCtx.resume();
            // Play a 1-sample silent buffer — required to fully unlock iOS audio
            const buf = unlockedAudioCtx.createBuffer(1, 1, 24000);
            const src = unlockedAudioCtx.createBufferSource();
            src.buffer = buf;
            src.connect(unlockedAudioCtx.destination);
            src.start(0);
        } catch (_) {
            unlockedAudioCtx = null;
        }

        try {
            // 1. Camera
            await this.mediaManager.requestCameraAndMic(this._facingMode);
            this.mediaManager.attachToVideo(this.videoEl);
            this.cameraPlaceholder.classList.add('hidden');
            await this.videoEl.play();
            this.videoEl.style.transform = 'scaleX(-1)'; // mirror front camera

            // 2. Microphone permission — requested here for transparency so the
            //    browser shows one permission prompt. AudioRecorder manages its
            //    own stream for active sessions; we just get permission now.
            try {
                const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                micStream.getTracks().forEach(t => t.stop());
            } catch (_) {
                // Mic denied — active sessions will fail but passive mode still works
            }

            // 3. Passive mode controller
            this.passiveMode = new PassiveMode({
                videoElement: this.videoEl,
                onTopic: (text) => this._onTopicSuggested(text),
                onStatus: (msg) => this._onPassiveStatus(msg),
                onError: (msg) => this._showError(msg),
            });

            // 4. Inject the pre-unlocked AudioContext so PassiveMode reuses it.
            //    This avoids creating a new context (which would be suspended on iOS).
            if (unlockedAudioCtx) {
                this.passiveMode._sharedAudioCtx = unlockedAudioCtx;
            } else {
                // Fallback for non-iOS browsers
                this.passiveMode.unlockAudio();
            }

            // 5. UI: enable controls
            this.frequencySelect.disabled = false;
            this.activateBtn.classList.add('hidden');
            this.deactivateBtn.classList.remove('hidden');
            this.flipCameraBtn.classList.remove('hidden');

            this.mode = 'passive';
            this._setStatus('idle', 'Ready — choose a topic interval');
        } catch (error) {
            console.error('Activation failed:', error);
            this._setStatus('error', `Could not activate: ${error.message}`);
            if (unlockedAudioCtx) { try { unlockedAudioCtx.close(); } catch (_) {} }
            this.activateBtn.disabled = false;
        }
    }

    _deactivate() {
        if (this.mode !== 'passive') return;

        if (this.passiveMode) {
            this.passiveMode.stop();
            this.passiveMode = null;
        }
        this.mediaManager.stop();
        this.videoEl.srcObject = null;
        this.videoEl.style.transform = '';

        // Reset UI
        this.cameraPlaceholder.classList.remove('hidden');
        this.flipCameraBtn.classList.add('hidden');
        this.deactivateBtn.classList.add('hidden');
        this.activateBtn.classList.remove('hidden');
        this.activateBtn.disabled = false;
        this.frequencySelect.disabled = true;
        this.frequencySelect.value = '0';
        this.countdownEl.classList.add('hidden');
        this.topicCard.classList.add('hidden');

        this.mode = 'idle';
        this.currentTopic = '';
        this._setStatus('idle', 'Ready to start');
    }

    // ─── Camera flip ──────────────────────────────────────────────────────────

    async _flipCamera() {
        if (this.mode !== 'passive' || !this.mediaManager.stream) return;

        const prevFacingMode = this._facingMode;
        this._facingMode = prevFacingMode === 'user' ? 'environment' : 'user';

        try {
            // Only swap the media stream — passiveMode reads the videoElement via
            // drawImage() and is completely unaware of camera changes, so the timer
            // and countdown continue running without any interruption.
            await this.mediaManager.requestCameraAndMic(this._facingMode);
            this.mediaManager.attachToVideo(this.videoEl);
            await this.videoEl.play();
            this.videoEl.style.transform = this._facingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
        } catch (error) {
            // Restore previous facing mode on failure
            this._facingMode = prevFacingMode;
            try {
                await this.mediaManager.requestCameraAndMic(this._facingMode);
                this.mediaManager.attachToVideo(this.videoEl);
                await this.videoEl.play();
            } catch (_) {}
            this._showError('Could not switch camera');
        }
    }

    // ─── Passive mode callbacks ────────────────────────────────────────────────

    _onPassiveStatus(msg) {
        // Parse countdown messages — only the countdown display shows the timer;
        // the status bar shows a simple word so the two never duplicate.
        const match = msg.match(/Next suggestion in (\d+)s/);
        if (match) {
            const sec = parseInt(match[1]);
            const min = Math.floor(sec / 60);
            const rem = sec % 60;
            // Clock-style format: "2:00", "0:45"
            const clock = `${min}:${String(rem).padStart(2, '0')}`;
            this.countdownLabelEl.textContent = 'Next topic in';
            this.countdownTimerEl.textContent = clock;
            this.countdownEl.classList.remove('hidden');
            this._setStatus('passive', 'Watching...');
        } else if (msg === 'Analyzing what you see...') {
            this.countdownLabelEl.textContent = '';
            this.countdownTimerEl.textContent = 'Analyzing...';
            this.countdownEl.classList.remove('hidden');
            this._setStatus('passive', 'Analyzing...');
        } else if (msg.includes('topic suggested')) {
            this.countdownEl.classList.add('hidden');
            this._setStatus('passive', 'Topic ready');
        } else if (msg.includes('paused')) {
            this.countdownEl.classList.add('hidden');
            this._setStatus('idle', 'Paused');
        } else {
            this._setStatus('passive', msg);
        }
    }

    _onTopicSuggested(text) {
        this.currentTopic = text;
        this.topicText.textContent = text;
        this.topicCard.classList.remove('hidden');
    }

    // ─── Active session ────────────────────────────────────────────────────────

    async startSession(topic = '') {
        try {
            if (this.passiveMode) this.passiveMode.stop();
            speechSynthesis.cancel();
            this.mode = 'active';
            this.passiveControls.classList.add('hidden');
            this.topicCard.classList.add('hidden');
            this.countdownEl.classList.add('hidden');
            this.flipCameraBtn.classList.add('hidden');

            this._setStatus('connecting', 'Connecting to tutor...');

            if (!this.mediaManager.stream) {
                await this.mediaManager.requestCameraAndMic(this._facingMode);
                this.mediaManager.attachToVideo(this.videoEl);
                this.cameraPlaceholder.classList.add('hidden');
                await this.videoEl.play();
            }

            const empty = this.transcriptEl.querySelector('.transcript-empty');
            if (empty) empty.remove();

            this.videoCapture = new VideoCapture(this.videoEl);

            const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const wsUrl = `${wsProto}://${window.location.host}/ws/speak`;
            this.wsClient = new WebSocketClient(wsUrl);
            this._setupWSHandlers();

            this._setStatus('connecting', 'Connecting to server...');
            await this.wsClient.connect();

            const config = {};
            if (topic) config.topic = topic;
            this.wsClient.sendStartSession(config);

        } catch (error) {
            console.error('Failed to start session:', error);
            this._setStatus('error', `Error: ${error.message}`);
            this.stopSession();
        }
    }

    _setupWSHandlers() {
        this.wsClient.on('status', (msg) => {
            if (msg.status === 'ready') {
                this._onSessionReady();
            } else if (msg.status === 'reconnecting') {
                this._setStatus('connecting', 'Reconnecting...');
            } else if (msg.status === 'error') {
                this._setStatus('error', msg.message || 'Server error');
            }
        });

        this.wsClient.on('audio', (msg) => { this.audioPlayer.playChunk(msg.data); });
        this.wsClient.on('transcript', (msg) => { this._addTranscript(msg.role, msg.content); });
        this.wsClient.on('correction', (msg) => { this._addCorrection(msg.original, msg.corrected, msg.rule); });
        this.wsClient.on('vocabulary', (msg) => { this._addVocabulary(msg.word, msg.definition, msg.example); });

        this.wsClient.on('disconnected', () => {
            if (this.isSessionActive) {
                this._setStatus('error', 'Connection lost');
                this.stopSession();
            }
        });
        this.wsClient.on('error', () => { this._setStatus('error', 'Connection error'); });
    }

    _onSessionReady() {
        this.isSessionActive = true;
        this._setStatus('active', 'Session active — speak freely!');
        this.stopBtn.classList.remove('hidden');

        this.audioRecorder.start((base64Audio) => { this.wsClient.sendAudio(base64Audio); });
        this.videoCapture.start((base64Frame) => { this.wsClient.sendVideo(base64Frame); });
        this.audioPlayer.init();
    }

    stopSession() {
        this.isSessionActive = false;

        if (this.videoCapture) { this.videoCapture.stop(); this.videoCapture = null; }
        this.audioRecorder.stop();
        this.audioPlayer.stop();

        if (this.wsClient) {
            if (this.wsClient.isConnected) this.wsClient.sendEndSession();
            this.wsClient.disconnect();
            this.wsClient = null;
        }

        this.stopBtn.classList.add('hidden');
        this.passiveControls.classList.remove('hidden');
        this.flipCameraBtn.classList.remove('hidden');

        this.mode = 'passive';
        this.currentTopic = '';
        this.topicCard.classList.add('hidden');

        const ms = parseInt(this.frequencySelect.value);
        if (this.passiveMode && ms > 0) {
            this.passiveMode.setInterval(ms);
            this._setStatus('passive', 'Watching...');
        } else {
            this._setStatus('idle', 'Ready — choose a topic interval');
        }
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    _showError(msg) {
        if (this._errorDismissTimer) clearTimeout(this._errorDismissTimer);
        this.errorToastMsg.textContent = msg;
        this.errorToast.classList.remove('hidden');
        this._errorDismissTimer = setTimeout(() => this._hideError(), 6000);
    }

    _hideError() {
        this.errorToast.classList.add('hidden');
        if (this._errorDismissTimer) {
            clearTimeout(this._errorDismissTimer);
            this._errorDismissTimer = null;
        }
    }

    _setStatus(state, message) {
        this.statusEl.textContent = message;
        this.statusDot.className = `status-dot ${state}`;
    }

    _addTranscript(role, content) {
        const entry = document.createElement('div');
        entry.className = `transcript-entry ${role}`;
        const label = document.createElement('span');
        label.className = 'transcript-label';
        label.textContent = role === 'ai' ? 'Tutor' : 'You';
        const text = document.createElement('span');
        text.className = 'transcript-text';
        text.textContent = content;
        entry.appendChild(label);
        entry.appendChild(text);
        this.transcriptEl.appendChild(entry);
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    }

    _addCorrection(original, corrected, rule) {
        const entry = document.createElement('div');
        entry.className = 'transcript-entry correction';
        entry.innerHTML = `
            <span class="correction-icon">&#9998;</span>
            <div class="correction-content">
                <div class="correction-original">${original}</div>
                <div class="correction-arrow">&#8594;</div>
                <div class="correction-fixed">${corrected}</div>
                <div class="correction-rule">${rule}</div>
            </div>
        `;
        this.transcriptEl.appendChild(entry);
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    }

    _addVocabulary(word, definition, example) {
        const entry = document.createElement('div');
        entry.className = 'transcript-entry vocabulary';
        entry.innerHTML = `
            <span class="vocab-icon">&#128218;</span>
            <div class="vocab-content">
                <div class="vocab-word">${word}</div>
                <div class="vocab-definition">${definition}</div>
                <div class="vocab-example">"${example}"</div>
            </div>
        `;
        this.transcriptEl.appendChild(entry);
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    }
}

document.addEventListener('DOMContentLoaded', () => { new App(); });
