/**
 * Manages camera and microphone permissions and streams.
 */
export class MediaManager {
    constructor() {
        this.stream = null;
    }

    async requestCameraAndMic(facingMode = 'user') {
        if (!navigator.mediaDevices) {
            throw new Error('Camera requires HTTPS. Use https:// in the URL.');
        }
        // Stop any existing stream before requesting a new one
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        this.stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 768 },
                height: { ideal: 768 },
                facingMode: facingMode,
            },
            audio: false // Audio handled separately by AudioRecorder
        });
        return this.stream;
    }

    attachToVideo(videoElement) {
        if (this.stream) {
            videoElement.srcObject = this.stream;
        }
    }

    stop() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
    }
}
