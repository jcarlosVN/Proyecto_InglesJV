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
        this.enableAudioBtn = document.getElementById('btn-enable-audio');
        this.countdownEl = document.getElementById('countdown-display');

        this._bindEvents();
        this._initPassiveMode();
    }

    _bindEvents() {
        this.stopBtn.addEventListener('click', () => this.stopSession());
        this.startConversationBtn.addEventListener('click', () => this.startSession(this.currentTopic));

        // Unlock audio on explicit button tap (required for iOS Safari)
        this.enableAudioBtn.addEventListener('click', () => {
            if (this.passiveMode) this.passiveMode.unlockAudio();
            this.enableAudioBtn.classList.add('hidden');
        });

        this.frequencySelect.addEventListener('change', () => {
            const ms = parseInt(this.frequencySelect.value);
            if (this.passiveMode) {
                // User gesture — also try to unlock audio (helps on some iOS versions)
                this.passiveMode.unlockAudio();
                this.passiveMode.setInterval(ms);
            }
        });
    }

    async _initPassiveMode() {
        try {
            this._setStatus('connecting', 'Requesting camera...');
            const stream = await this.mediaManager.requestCameraAndMic();
            this.mediaManager.attachToVideo(this.videoEl);
            this.cameraPlaceholder.classList.add('hidden');
            await this.videoEl.play();

            this.passiveMode = new PassiveMode({
                videoElement: this.videoEl,
                onTopic: (text) => this._onTopicSuggested(text),
                onStatus: (msg) => this._onPassiveStatus(msg),
                onError: (msg) => this._setStatus('error', `Passive: ${msg}`),
            });

            // Do NOT auto-start — wait for user to select a frequency
            this.mode = 'passive';
            this._setStatus('idle', 'Select a frequency to begin');
        } catch (error) {
            console.error('Failed to init passive mode:', error);
            this._setStatus('error', `Camera error: ${error.message}`);
        }
    }

    _onPassiveStatus(msg) {
        this._setStatus('passive', msg);

        // Update the dedicated countdown display
        const match = msg.match(/Next suggestion in (\d+)s/);
        if (match) {
            const sec = parseInt(match[1]);
            const min = Math.floor(sec / 60);
            const rem = sec % 60;
            const formatted = min > 0
                ? (rem > 0 ? `${min}m ${rem}s` : `${min}m`)
                : `${sec}s`;
            this.countdownEl.textContent = `Next topic in ${formatted}`;
            this.countdownEl.classList.remove('hidden');
        } else if (msg === 'Analyzing what you see...') {
            this.countdownEl.textContent = 'Analyzing...';
            this.countdownEl.classList.remove('hidden');
        } else {
            this.countdownEl.classList.add('hidden');
        }
    }

    _onTopicSuggested(text) {
        this.currentTopic = text;
        this.topicText.textContent = text;
        this.topicCard.classList.remove('hidden');
    }

    async startSession(topic = '') {
        try {
            // Stop passive mode
            if (this.passiveMode) {
                this.passiveMode.stop();
            }
            speechSynthesis.cancel();
            this.mode = 'active';
            this.passiveControls.classList.add('hidden');
            this.topicCard.classList.add('hidden');

            this._setStatus('connecting', 'Connecting to tutor...');

            // Camera should already be running from passive mode
            // If not, request it
            if (!this.mediaManager.stream) {
                const stream = await this.mediaManager.requestCameraAndMic();
                this.mediaManager.attachToVideo(this.videoEl);
                this.cameraPlaceholder.classList.add('hidden');
                await this.videoEl.play();
            }

            // Clear transcript placeholder
            const empty = this.transcriptEl.querySelector('.transcript-empty');
            if (empty) empty.remove();

            // Setup video capture (1 FPS)
            this.videoCapture = new VideoCapture(this.videoEl);

            // Connect WebSocket (wss:// on HTTPS, ws:// on HTTP)
            const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const wsUrl = `${wsProto}://${window.location.host}/ws/speak`;
            this.wsClient = new WebSocketClient(wsUrl);
            this._setupWSHandlers();

            this._setStatus('connecting', 'Connecting to server...');
            await this.wsClient.connect();

            // Send start session message with optional topic
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

        this.wsClient.on('audio', (msg) => {
            this.audioPlayer.playChunk(msg.data);
        });

        this.wsClient.on('transcript', (msg) => {
            this._addTranscript(msg.role, msg.content);
        });

        this.wsClient.on('correction', (msg) => {
            this._addCorrection(msg.original, msg.corrected, msg.rule);
        });

        this.wsClient.on('vocabulary', (msg) => {
            this._addVocabulary(msg.word, msg.definition, msg.example);
        });

        this.wsClient.on('disconnected', () => {
            if (this.isSessionActive) {
                this._setStatus('error', 'Connection lost');
                this.stopSession();
            }
        });

        this.wsClient.on('error', () => {
            this._setStatus('error', 'Connection error');
        });
    }

    _onSessionReady() {
        this.isSessionActive = true;
        this._setStatus('active', 'Session active - speak freely!');

        // Show stop button
        this.stopBtn.classList.remove('hidden');

        // Start sending audio
        this.audioRecorder.start((base64Audio) => {
            this.wsClient.sendAudio(base64Audio);
        });

        // Start sending video frames
        this.videoCapture.start((base64Frame) => {
            this.wsClient.sendVideo(base64Frame);
        });

        // Init audio player
        this.audioPlayer.init();
    }

    stopSession() {
        this.isSessionActive = false;

        // Stop media streams for active mode
        if (this.videoCapture) {
            this.videoCapture.stop();
            this.videoCapture = null;
        }
        this.audioRecorder.stop();
        this.audioPlayer.stop();

        // Stop WebSocket
        if (this.wsClient) {
            if (this.wsClient.isConnected) {
                this.wsClient.sendEndSession();
            }
            this.wsClient.disconnect();
            this.wsClient = null;
        }

        // Toggle buttons
        this.stopBtn.classList.add('hidden');
        this.passiveControls.classList.remove('hidden');

        // Return to passive mode (camera stays on)
        this.mode = 'passive';
        this.currentTopic = '';
        this.topicCard.classList.add('hidden');

        const ms = parseInt(this.frequencySelect.value);
        if (this.passiveMode && ms > 0) {
            this.passiveMode.setInterval(ms);
            this.passiveMode.start();
            this._setStatus('passive', 'Passive mode - waiting for next analysis...');
        } else {
            this._setStatus('passive', 'Passive mode - paused');
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

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new App();
});
