/**
 * WebSocket client that connects to FastAPI backend.
 * Sends audio/video data and dispatches incoming messages.
 */
export class WebSocketClient {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.handlers = {};
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);

            this.ws.onopen = () => {
                this.reconnectAttempts = 0;
                this._emit('connected');
                resolve();
            };

            this.ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    this._emit(msg.type, msg);
                } catch (e) {
                    console.error('Failed to parse WS message:', e);
                }
            };

            this.ws.onclose = (event) => {
                this._emit('disconnected', { code: event.code, reason: event.reason });
            };

            this.ws.onerror = (error) => {
                this._emit('error', error);
                reject(error);
            };
        });
    }

    on(eventType, handler) {
        if (!this.handlers[eventType]) {
            this.handlers[eventType] = [];
        }
        this.handlers[eventType].push(handler);
    }

    _emit(eventType, data) {
        const handlers = this.handlers[eventType] || [];
        handlers.forEach(handler => handler(data));
    }

    sendAudio(base64Data) {
        this._send({ type: 'audio', data: base64Data });
    }

    sendVideo(base64Data) {
        this._send({ type: 'video', data: base64Data });
    }

    sendStartSession(config = {}) {
        this._send({ type: 'start_session', config });
    }

    sendEndSession() {
        this._send({ type: 'end_session' });
    }

    _send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    get isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }
}
