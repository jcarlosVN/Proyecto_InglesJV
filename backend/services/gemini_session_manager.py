"""
Core component: manages Gemini Live API connection with automatic
session resumption and context window compression.
"""

import asyncio
import base64
import logging
from google import genai
from google.genai import types
from google.genai.types import (
    LiveConnectConfig,
    Modality,
    AudioTranscriptionConfig,
    ContextWindowCompressionConfig,
    SlidingWindow,
    SessionResumptionConfig,
)

logger = logging.getLogger(__name__)


class GeminiSessionManager:
    def __init__(self, api_key: str, model: str):
        self.client = genai.Client(api_key=api_key)
        self.model = model
        self.session = None
        self._session_ctx = None  # async context manager
        self.resumption_handle: str | None = None
        self.system_instruction: str = ""
        self._on_audio = None
        self._on_text = None
        self._on_input_transcript = None
        self._on_output_transcript = None
        self._on_status = None
        self._listener_task: asyncio.Task | None = None
        self._running = False

    def on_audio(self, callback):
        """Register callback for audio output: callback(base64_pcm_data)"""
        self._on_audio = callback

    def on_text(self, callback):
        """Register callback for text output: callback(text)"""
        self._on_text = callback

    def on_input_transcript(self, callback):
        """Register callback for user speech transcription: callback(text)"""
        self._on_input_transcript = callback

    def on_output_transcript(self, callback):
        """Register callback for AI speech transcription: callback(text)"""
        self._on_output_transcript = callback

    def on_status(self, callback):
        """Register callback for status changes: callback(status, message)"""
        self._on_status = callback

    def _build_config(self) -> LiveConnectConfig:
        config = LiveConnectConfig(
            response_modalities=[Modality.AUDIO],
            system_instruction=self.system_instruction,
            input_audio_transcription=AudioTranscriptionConfig(),
            output_audio_transcription=AudioTranscriptionConfig(),
            context_window_compression=ContextWindowCompressionConfig(
                sliding_window=SlidingWindow(target_tokens=1024),
            ),
            session_resumption=SessionResumptionConfig(
                handle=self.resumption_handle,
            ) if self.resumption_handle else None,
        )
        return config

    async def connect(self, system_instruction: str):
        """Establish a new Gemini Live session."""
        self.system_instruction = system_instruction
        self._running = True
        await self._establish_connection()

    async def _establish_connection(self):
        """Internal: create the WebSocket connection to Gemini."""
        config = self._build_config()
        try:
            # connect() returns an async context manager, enter it manually
            self._session_ctx = self.client.aio.live.connect(
                model=self.model, config=config
            )
            self.session = await self._session_ctx.__aenter__()
            logger.info("Connected to Gemini Live API")

            # Start background listener
            if self._listener_task and not self._listener_task.done():
                self._listener_task.cancel()
            self._listener_task = asyncio.create_task(self._listen_loop())

        except Exception as e:
            logger.error(f"Failed to connect to Gemini: {e}")
            raise

    async def _listen_loop(self):
        """Continuously read messages from Gemini and dispatch to callbacks.

        session.receive() yields messages until turn_complete, then stops.
        We wrap it in an outer while loop to keep listening for subsequent turns.
        """
        try:
            while self._running:
                async for message in self.session.receive():
                    if not self._running:
                        break

                    # Session resumption handle update
                    if message.session_resumption_update:
                        sru = message.session_resumption_update
                        if sru.resumable and sru.new_handle:
                            self.resumption_handle = sru.new_handle
                            logger.debug("Updated resumption handle")

                    # Go away - server is about to disconnect
                    if message.go_away:
                        logger.info("Received go_away, reconnecting...")
                        if self._on_status:
                            await self._on_status("reconnecting", "Extending session...")
                        await self._reconnect()
                        return

                    # Server content (audio, text, transcriptions)
                    if message.server_content:
                        sc = message.server_content

                        # Input transcription (what the user said)
                        if sc.input_transcription and sc.input_transcription.text:
                            if self._on_input_transcript:
                                await self._on_input_transcript(sc.input_transcription.text)

                        # Output transcription (what the AI said)
                        if sc.output_transcription and sc.output_transcription.text:
                            if self._on_output_transcript:
                                await self._on_output_transcript(sc.output_transcription.text)

                        # Model turn (audio and/or text parts)
                        if sc.model_turn and sc.model_turn.parts:
                            for part in sc.model_turn.parts:
                                if part.inline_data and part.inline_data.mime_type and 'audio' in part.inline_data.mime_type:
                                    if self._on_audio:
                                        b64 = base64.b64encode(part.inline_data.data).decode()
                                        await self._on_audio(b64)
                                if part.text:
                                    if self._on_text:
                                        await self._on_text(part.text)

                # receive() finished (turn_complete) - loop back for next turn
                logger.debug("Turn complete, waiting for next turn...")

        except asyncio.CancelledError:
            logger.debug("Listener cancelled")
        except Exception as e:
            logger.error(f"Listener error: {e}")
            if self._running and self.resumption_handle:
                logger.info("Attempting reconnection after error...")
                if self._on_status:
                    await self._on_status("reconnecting", "Reconnecting...")
                await self._reconnect()
            elif self._running:
                if self._on_status:
                    await self._on_status("error", str(e))

    async def _reconnect(self):
        """Transparently reconnect using stored resumption handle."""
        try:
            await self._close_session()
            await asyncio.sleep(0.5)
            await self._establish_connection()
            if self._on_status:
                await self._on_status("ready", "Session resumed")
            logger.info("Successfully reconnected to Gemini")
        except Exception as e:
            logger.error(f"Reconnection failed: {e}")
            if self._on_status:
                await self._on_status("error", f"Reconnection failed: {e}")

    async def send_text(self, text: str):
        """Send a text message as user input (triggers AI response)."""
        if not self.session:
            return
        try:
            await self.session.send_client_content(
                turns=[types.Content(role="user", parts=[types.Part(text=text)])]
            )
        except Exception as e:
            logger.error(f"Error sending text: {e}")

    async def send_audio(self, base64_audio: str):
        """Send audio chunk (base64-encoded 16-bit PCM 16kHz mono)."""
        if not self.session:
            return
        try:
            audio_bytes = base64.b64decode(base64_audio)
            await self.session.send_realtime_input(
                audio=types.Blob(
                    data=audio_bytes,
                    mime_type="audio/pcm;rate=16000"
                )
            )
        except Exception as e:
            logger.error(f"Error sending audio: {e}")

    async def send_video(self, base64_jpeg: str):
        """Send video frame (base64-encoded JPEG)."""
        if not self.session:
            return
        try:
            jpeg_bytes = base64.b64decode(base64_jpeg)
            await self.session.send_realtime_input(
                video=types.Blob(
                    data=jpeg_bytes,
                    mime_type="image/jpeg"
                )
            )
        except Exception as e:
            logger.error(f"Error sending video: {e}")

    async def _close_session(self):
        """Close the Gemini session context manager."""
        if self._session_ctx:
            try:
                await self._session_ctx.__aexit__(None, None, None)
            except Exception:
                pass
            self._session_ctx = None
            self.session = None

    async def close(self):
        """Close the session and clean up."""
        self._running = False
        if self._listener_task and not self._listener_task.done():
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass
        await self._close_session()
        logger.info("Gemini session closed")
