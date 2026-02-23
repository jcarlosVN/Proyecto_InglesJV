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
        this._keepAliveId = null;     // setInterval for silent pings

        // Resume AudioContext when the page returns to foreground.
        // iOS marks it 'interrupted' when the user switches apps / locks screen.
        this._onVisibilityChange = () => {
            if (document.hidden) return;
            const ctx = this._sharedAudioCtx;
            if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
                ctx.resume().catch(() => {});
            }
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);
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
     * Full teardown — call when the user deactivates the session.
     * Stops the timer, clears the keep-alive ping, removes the visibility
     * listener and closes the AudioContext.
     */
    destroy() {
        this.stop();
        this._stopContextKeepAlive();
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        if (this._sharedAudioCtx && this._sharedAudioCtx.state !== 'closed') {
            try { this._sharedAudioCtx.close(); } catch (_) {}
        }
        this._sharedAudioCtx = null;
    }

    /**
     * Must be called from a user-gesture handler (tap/click).
     * Creates and unlocks the AudioContext for iOS Safari, then starts the
     * keep-alive ping so iOS does not auto-suspend after 30 s of silence.
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
        this._startContextKeepAlive();
    }

    /**
     * Plays a 1-sample silent buffer every 5 s to prevent iOS Safari from
     * auto-suspending the AudioContext during long countdown intervals.
     */
    _startContextKeepAlive() {
        this._stopContextKeepAlive();
        this._keepAliveId = setInterval(() => {
            const ctx = this._sharedAudioCtx;
            if (!ctx || ctx.state === 'closed') {
                this._stopContextKeepAlive();
                return;
            }
            if (ctx.state === 'running') {
                // Silent ping to keep the context active on iOS
                try {
                    const buf = ctx.createBuffer(1, 1, 24000);
                    const src = ctx.createBufferSource();
                    src.buffer = buf;
                    src.connect(ctx.destination);
                    src.start(ctx.currentTime);
                } catch (_) {}
            } else {
                // Try to resume if suspended (works on Chrome; may need gesture on iOS)
                ctx.resume().catch(() => {});
            }
        }, 5000);
    }

    _stopContextKeepAlive() {
        if (this._keepAliveId) {
            clearInterval(this._keepAliveId);
            this._keepAliveId = null;
        }
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
                    this._playAudio(data.audio, data.text);
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
            // Use currentTime (not 0) so we never schedule in the past
            source.start(ctx.currentTime);
            this._currentSource = source;
            source.onended = () => {
                if (this._currentSource === source) this._currentSource = null;
            };
        };

        // Check for any non-running state ('suspended' on Chrome, 'interrupted' on iOS)
        if (ctx.state !== 'running') {
            ctx.resume()
                .then(() => {
                    // Verify the context actually resumed before playing
                    if (ctx.state === 'running') {
                        doPlay();
                    } else {
                        // Context could not be resumed (iOS requires a new gesture)
                        if (fallbackText) this._speakFallback(fallbackText);
                    }
                })
                .catch(() => {
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

        // Mobile browsers preferred voices (Google/Apple voices available on device)
        const preferred = [
            'Samantha',          // iOS default English
            'Karen',             // iOS Australian
            'Google US English', // Android Chrome
            'Microsoft Jenny',   // Windows
            'Microsoft Aria',    // Windows
        ];

        const doSpeak = (voices) => {
            for (const name of preferred) {
                const match = voices.find(v => v.name.includes(name) && v.lang.startsWith('en'));
                if (match) { utterance.voice = match; break; }
            }
            speechSynthesis.speak(utterance);
        };

        const voices = speechSynthesis.getVoices();
        if (voices.length > 0) {
            doSpeak(voices);
        } else {
            // Mobile browsers load voices asynchronously — wait for the event
            speechSynthesis.addEventListener('voiceschanged', () => {
                doSpeak(speechSynthesis.getVoices());
            }, { once: true });
            // Safety: if voiceschanged never fires, speak with the browser default
            setTimeout(() => {
                if (!utterance.voice) speechSynthesis.speak(utterance);
            }, 1000);
        }
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
