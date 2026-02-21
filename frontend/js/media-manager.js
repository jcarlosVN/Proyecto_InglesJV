/**
 * Manages camera and microphone permissions and streams.
 */
export class MediaManager {
    constructor() {
        this.stream = null;
    }

    async requestCameraAndMic() {
        if (!navigator.mediaDevices) {
            throw new Error('Camera requires HTTPS. Use https:// in the URL.');
        }
        this.stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 768 },
                height: { ideal: 768 },
                facingMode: 'user',
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
