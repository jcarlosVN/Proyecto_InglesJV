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
        this._currentAudioCtx = null;
        this._countdownId = null;
    }

    start() {
        if (this.isActive) return;
        if (this.intervalMs === 0) {
            this.onStatus?.('Passive mode - paused');
            return;
        }
        this.isActive = true;
        this.videoCapture = new VideoCapture(this.videoElement);

        // Take first photo after a short delay to let camera warm up
        this.timerId = setTimeout(() => this._tick(), 3000);
        this.onStatus?.('Passive mode - analyzing in a moment...');
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
        if (this._currentAudioCtx) {
            this._currentAudioCtx.close();
            this._currentAudioCtx = null;
        }
        speechSynthesis.cancel();
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

        try {
            // Capture single frame
            const base64Frame = await this._captureFrame();
            if (!base64Frame) {
                this.onStatus?.('Passive mode - waiting for camera...');
                this._requesting = false;
                this._scheduleNext();
                return;
            }

            // Send to backend
            const response = await fetch('/api/suggest-topic', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: base64Frame }),
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }

            const data = await response.json();

            // Show topic and speak it
            if (data.text) {
                this.onTopic?.(data.text);
                if (data.audio) {
                    this._playAudio(data.audio);
                } else {
                    this._speakFallback(data.text);
                }
            }

            this.onStatus?.('Passive mode - topic suggested');
        } catch (err) {
            console.error('Passive mode error:', err);
            this.onError?.(err.message);
        } finally {
            this._requesting = false;
            this._scheduleNext();
        }
    }

    _playAudio(base64PcmData) {
        // Stop any currently playing audio
        if (this._currentAudioCtx) {
            this._currentAudioCtx.close();
            this._currentAudioCtx = null;
        }
        speechSynthesis.cancel();

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

        const ctx = new AudioContext({ sampleRate: 24000 });
        this._currentAudioCtx = ctx;
        const audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
        audioBuffer.getChannelData(0).set(float32Array);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.start(0);
        source.onended = () => {
            ctx.close();
            if (this._currentAudioCtx === ctx) {
                this._currentAudioCtx = null;
            }
        };
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
