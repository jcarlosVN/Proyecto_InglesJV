/**
 * Plays PCM audio chunks (24kHz, 16-bit, mono) from Gemini responses.
 * Schedules chunks seamlessly for gap-free playback.
 */
export class AudioPlayer {
    constructor() {
        this.audioContext = null;
        this.nextStartTime = 0;
        this.isPlaying = false;
    }

    init() {
        this.audioContext = new AudioContext({ sampleRate: 24000 });
        this.nextStartTime = 0;
        this.isPlaying = true;
    }

    playChunk(base64PcmData) {
        if (!this.audioContext || !this.isPlaying) return;

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

        const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, 24000);
        audioBuffer.getChannelData(0).set(float32Array);

        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);

        const now = this.audioContext.currentTime;
        const startTime = Math.max(now, this.nextStartTime);
        source.start(startTime);
        this.nextStartTime = startTime + audioBuffer.duration;
    }

    stop() {
        this.isPlaying = false;
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.nextStartTime = 0;
    }

    /** Interrupt current playback (e.g., when user starts speaking) */
    interrupt() {
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = new AudioContext({ sampleRate: 24000 });
            this.nextStartTime = 0;
        }
    }
}
