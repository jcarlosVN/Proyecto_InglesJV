/**
 * Captures video frames from camera at 1 FPS.
 * Outputs JPEG base64-encoded frames resized to 768x768.
 */
export class VideoCapture {
    constructor(videoElement) {
        this.video = videoElement;
        this.canvas = document.createElement('canvas');
        this.canvas.width = 768;
        this.canvas.height = 768;
        this.ctx = this.canvas.getContext('2d');
        this.intervalId = null;
    }

    start(onFrameCallback) {
        this.intervalId = setInterval(() => {
            if (this.video.readyState < 2) return; // Not enough data yet

            // Draw current frame, scaled to 768x768
            this.ctx.drawImage(this.video, 0, 0, 768, 768);

            this.canvas.toBlob((blob) => {
                if (!blob) return;
                const reader = new FileReader();
                reader.onloadend = () => {
                    // reader.result = "data:image/jpeg;base64,<DATA>"
                    const base64Data = reader.result.split(',')[1];
                    onFrameCallback(base64Data);
                };
                reader.readAsDataURL(blob);
            }, 'image/jpeg', 0.7);
        }, 1000); // 1 FPS
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
}
