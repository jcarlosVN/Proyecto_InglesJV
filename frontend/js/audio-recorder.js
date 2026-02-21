/**
 * Captures microphone audio as 16-bit PCM, 16kHz mono.
 * Sends base64-encoded chunks via callback.
 */
export class AudioRecorder {
    constructor() {
        this.audioContext = null;
        this.stream = null;
        this.processor = null;
        this.source = null;
        this.isRecording = false;
    }

    async start(onChunkCallback) {
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            }
        });

        this.audioContext = new AudioContext({ sampleRate: 16000 });
        this.source = this.audioContext.createMediaStreamSource(this.stream);

        // Use ScriptProcessorNode (works across all browsers)
        this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

        this.processor.onaudioprocess = (event) => {
            if (!this.isRecording) return;

            const float32Data = event.inputBuffer.getChannelData(0);
            const int16Data = this._float32ToInt16(float32Data);
            const base64 = this._arrayBufferToBase64(int16Data.buffer);
            onChunkCallback(base64);
        };

        // Connect through a silent gain node to prevent mic audio playing
        // back through speakers (which confuses echo cancellation)
        this.silentGain = this.audioContext.createGain();
        this.silentGain.gain.value = 0;

        this.source.connect(this.processor);
        this.processor.connect(this.silentGain);
        this.silentGain.connect(this.audioContext.destination);
        this.isRecording = true;
    }

    stop() {
        this.isRecording = false;

        if (this.silentGain) {
            this.silentGain.disconnect();
            this.silentGain = null;
        }
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }
        if (this.source) {
            this.source.disconnect();
            this.source = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
    }

    _float32ToInt16(float32Array) {
        const int16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return int16Array;
    }

    _arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    }
}
