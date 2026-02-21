"""
WebSocket endpoint for Speak Mode.
Relays audio/video between browser and Gemini Live API.
"""

import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from config import settings
from services.gemini_session_manager import GeminiSessionManager
from services.english_tutor import build_speak_mode_prompt

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/speak")
async def speak_mode(websocket: WebSocket):
    await websocket.accept()

    manager = GeminiSessionManager(
        api_key=settings.GEMINI_API_KEY,
        model=settings.GEMINI_MODEL,
    )

    async def on_audio(base64_data):
        try:
            await websocket.send_json({"type": "audio", "data": base64_data})
        except Exception:
            pass

    async def on_text(text):
        try:
            await websocket.send_json({
                "type": "transcript", "role": "ai", "content": text
            })
        except Exception:
            pass

    async def on_input_transcript(text):
        try:
            await websocket.send_json({
                "type": "transcript", "role": "user", "content": text
            })
        except Exception:
            pass

    async def on_output_transcript(text):
        try:
            await websocket.send_json({
                "type": "transcript", "role": "ai", "content": text
            })
        except Exception:
            pass

    async def on_status(status, message):
        try:
            await websocket.send_json({
                "type": "status", "status": status, "message": message
            })
        except Exception:
            pass

    manager.on_audio(on_audio)
    manager.on_text(on_text)
    manager.on_input_transcript(on_input_transcript)
    manager.on_output_transcript(on_output_transcript)
    manager.on_status(on_status)

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)

            if msg["type"] == "start_session":
                config = msg.get("config", {})
                level = config.get("language_level", "intermediate")
                topic = config.get("topic", "")
                system_prompt = build_speak_mode_prompt(level, topic=topic)
                await manager.connect(system_prompt)

                # If there's a topic, send it as the first user message to trigger AI
                if topic:
                    await manager.send_text(
                        f"Hey! I'd love to talk about this: {topic}"
                    )

                await websocket.send_json({
                    "type": "status", "status": "ready",
                    "message": "Session started. Speak freely!"
                })
                logger.info("Speak session started")

            elif msg["type"] == "audio":
                await manager.send_audio(msg["data"])

            elif msg["type"] == "video":
                await manager.send_video(msg["data"])

            elif msg["type"] == "end_session":
                break

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({
                "type": "status", "status": "error", "message": str(e)
            })
        except Exception:
            pass
    finally:
        await manager.close()
