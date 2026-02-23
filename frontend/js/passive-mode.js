/**
 * Passive Mode controller.
 * Periodically captures a photo and requests an English topic suggestion.
 * Speaks the topic using Gemini TTS audio (fallback: browser SpeechSynthesis).
 */
import { VideoCapture } from './video-capture.js';

export class PassiveMode {
    constructor({ videoElement, onTopic, onStatus, onError }) {
        this.videoElement = videoElement;
        this.onTopic = onTopic;       // (text) => void
        this.onStatus = onStatus;     // (message) => void
        this.onError = onError;       // (message) => void

        this.videoCapture = null;
        this.timerId = null;
        this.intervalMs = 60000; // default 1 min
        this.isActive = false;
        this._requesting = false;
        this._sharedAudioCtx = null;  // persistent AudioContext (kept alive for iOS)
        this._currentSource = null;   // active BufferSourceNode
        this._countdownId = null;
        this._countdownTarget = 0;
    }

    start() {
        if (this.isActive) return;
        if (this.intervalMs === 0) {
            this.onStatus?.('Passive mode - paused');
            return;
        }
        this.isActive = true;
        this.videoCapture = new VideoCapture(this.videoElement);
        // Count down the full user-selected interval before the first capture
        this.timerId = setTimeout(() => this._tick(), this.intervalMs);
        this._startCountdown(this.intervalMs);
    }

    stop() {
        this.isActive = false;
        this._stopCountdown();
        if (this.timerId) {
            clearTimeout(this.timerId);
            this.timerId = null;
        }
        if (this.videoCapture) {
            this.videoCapture.stop();
            this.videoCapture = null;
        }
        // Stop active audio source but keep the shared AudioContext alive
        if (this._currentSource) {
            try { this._currentSource.stop(); } catch (e) {}
            this._currentSource = null;
        }
        speechSynthesis.cancel();
    }

    /**
     * Must be called from a user-gesture handler (tap/click).
     * Creates and unlocks the AudioContext for iOS Safari.
     */
    unlockAudio() {
        if (!this._sharedAudioCtx || this._sharedAudioCtx.state === 'closed') {
            this._sharedAudioCtx = new AudioContext({ sampleRate: 24000 });
        }
        const ctx = this._sharedAudioCtx;
        if (ctx.state === 'suspended') {
            ctx.resume();
        }
        // Play a 1-sample silent buffer — required to fully unlock iOS audio
        const buf = ctx.createBuffer(1, 1, 24000);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
    }

    setInterval(ms) {
        this.intervalMs = ms;
        if (ms === 0) {
            this.stop();
            this.onStatus?.('Passive mode - paused');
            return;
        }
        // If running, restart timer with new interval
        if (this.isActive && this.timerId && !this._requesting) {
            clearTimeout(this.timerId);
            this._stopCountdown();
            this.timerId = setTimeout(() => this._tick(), this.intervalMs);
            this._startCountdown(this.intervalMs);
        } else if (!this.isActive) {
            this.start();
        }
    }

    /** Returns milliseconds remaining until the next tick. */
    getRemainingMs() {
        if (!this.isActive || !this._countdownTarget) return 0;
        return Math.max(0, this._countdownTarget - Date.now());
    }

    /**
     * Resume the timer with a specific remaining delay (e.g. after camera swap).
     * Unlike setInterval(), this does NOT reset the countdown to the full interval.
     */
    resumeWithRemaining(remainingMs) {
        if (this.intervalMs === 0) return;
        this.isActive = true;
        this.videoCapture = new VideoCapture(this.videoElement);
        const delay = Math.max(1000, remainingMs); // at least 1 s
        this.timerId = setTimeout(() => this._tick(), delay);
        this._startCountdown(delay);
    }

    _tick() {
        if (!this.isActive) return;
        this._captureAndSuggest();
    }

    _scheduleNext() {
        if (!this.isActive || this.intervalMs === 0) return;
        this.timerId = setTimeout(() => this._tick(), this.intervalMs);
        this._startCountdown(this.intervalMs);
    }

    _startCountdown(totalMs) {
        this._stopCountdown();
        this._countdownTarget = Date.now() + totalMs;
        const update = () => {
            const remaining = Math.max(0, this._countdownTarget - Date.now());
            const sec = Math.ceil(remaining / 1000);
            if (sec <= 0) {
                this.onStatus?.('Analyzing what you see...');
                return;
            }
            this.onStatus?.(`Next suggestion in ${sec}s`);
            this._countdownId = setTimeout(update, 1000);
        };
        update();
    }

    _stopCountdown() {
        if (this._countdownId) {
            clearTimeout(this._countdownId);
            this._countdownId = null;
        }
    }

    async _captureAndSuggest() {
        if (this._requesting) return;
        this._requesting = true;
        this._stopCountdown();
        this.onStatus?.('Analyzing what you see...');

        let errorOccurred = false;
        try {
            // Capture single frame
            const base64Frame = await this._captureFrame();
            if (!base64Frame) {
                this.onStatus?.('Passive mode - waiting for camera...');
                return;
            }

            // Send to backend
            const response = await fetch('/api/suggest-topic', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: base64Frame }),
            });

            if (!response.ok) {
                let errorDetail = `Server error (${response.status})`;
                try {
                    const errData = await response.json();
                    if (errData.detail) errorDetail = errData.detail;
                } catch (_) {}
                throw new Error(errorDetail);
            }

            const data = await response.json();

            // Show topic and speak it
            if (data.text) {
                this.onTopic?.(data.text);
                if (data.audio) {
                    this._playAudio(data.audio, data.text);
                } else {
                    this._speakFallback(data.text);
                }
            }

            this.onStatus?.('Passive mode - topic suggested');
        } catch (err) {
            console.error('Passive mode error:', err);
            this.onError?.(err.message);
            errorOccurred = true;
        } finally {
            this._requesting = false;
            if (errorOccurred) {
                // Delay before rescheduling so user can read the error
                setTimeout(() => this._scheduleNext(), 6000);
            } else {
                this._scheduleNext();
            }
        }
    }

    _playAudio(base64PcmData, fallbackText = '') {
        // Stop currently playing audio
        if (this._currentSource) {
            try { this._currentSource.stop(); } catch (e) {}
            this._currentSource = null;
        }
        speechSynthesis.cancel();

        // Lazy-create the shared AudioContext (reused across plays)
        if (!this._sharedAudioCtx || this._sharedAudioCtx.state === 'closed') {
            this._sharedAudioCtx = new AudioContext({ sampleRate: 24000 });
        }
        const ctx = this._sharedAudioCtx;

        // Decode raw PCM (int16 little-endian → float32)
        const binaryString = atob(base64PcmData);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const int16Array = new Int16Array(bytes.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        const audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
        audioBuffer.getChannelData(0).set(float32Array);

        const doPlay = () => {
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            source.start(0);
            this._currentSource = source;
            source.onended = () => {
                if (this._currentSource === source) this._currentSource = null;
            };
        };

        // On iOS Safari the context starts suspended until a user gesture unlocks it.
        // If still suspended here, try to resume; if that fails, fall back to TTS.
        if (ctx.state === 'suspended') {
            ctx.resume().then(doPlay).catch(() => {
                if (fallbackText) this._speakFallback(fallbackText);
            });
        } else {
            doPlay();
        }
    }

    _speakFallback(text) {
        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'en-US';
        utterance.rate = 0.95;
        utterance.pitch = 1.0;

        const voices = speechSynthesis.getVoices();
        const preferred = [
            'Microsoft Jenny',
            'Microsoft Aria',
            'Google US English',
            'Samantha',
            'Karen',
        ];
        for (const name of preferred) {
            const match = voices.find(v => v.name.includes(name) && v.lang.startsWith('en'));
            if (match) { utterance.voice = match; break; }
        }

        speechSynthesis.speak(utterance);
    }

    _captureFrame() {
        return new Promise((resolve) => {
            if (!this.videoElement || this.videoElement.readyState < 2) {
                resolve(null);
                return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = 768;
            canvas.height = 768;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(this.videoElement, 0, 0, 768, 768);

            canvas.toBlob((blob) => {
                if (!blob) { resolve(null); return; }
                const reader = new FileReader();
                reader.onloadend = () => {
                    resolve(reader.result.split(',')[1]);
                };
                reader.readAsDataURL(blob);
            }, 'image/jpeg', 0.7);
        });
    }
}
