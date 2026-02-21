"""
Generates English topic suggestions from a single photo using Gemini standard API.
Two-step pipeline: Image → Text (gemini-2.5-flash), then Text → Audio (gemini TTS).
"""

import base64
import logging
from google import genai
from google.genai import types
from google.genai.types import SpeechConfig, VoiceConfig, PrebuiltVoiceConfig

logger = logging.getLogger(__name__)

TOPIC_PROMPT = """You are a friendly, casual English conversation buddy for a Spanish-speaking student.

Look at this photo from the student's camera. Take what you see as a context environment, 
search news as a context too, imagine if the senario will be tottaly diferente as another context, 
and then with all this context suggest ONE fun \
conversation topic in English that connects to something in their environment.

YOUR STYLE:
- Sound like a real friend chatting, NOT a robot or formal teacher
- Instead, jump straight into the topic with energy and curiosity
- Use casual language: contractions, informal expressions, friendly tone
- Total: 2-3 sentences max

GOOD EXAMPLES:
- "Oh cool, I see a guitar on the wall! Are you into music? What's the last song you learned to play?"
- "That coffee looks like it's keeping you going! Do you have a favorite cafe or do you prefer making your own?"
- "Do you like poo music? I find it so relaxing! What kind of music do you like to listen to when you're chilling?"
- "Hey, imagine if you could teleport anywhere right now. Where would you go? I bet it would be a fun place to chat about!"
- "Did you read Franz Kafka's 'The Metamorphosis'? I just read it and it's so wild! What do you think about the idea of waking up as a giant bug?"
- "I know Bitcoins fell a lot in price, but do you think they could make a comeback? Would you invest in them if they did?"

BAD EXAMPLES (don't do this):
- "I see you have a guitar on your desk." (robotic, boring)
- "I notice there are books on your shelf." (too formal)
- "It looks like you're in a workspace." (obvious, uninteresting)

IMPORTANT:
- Be genuinely curious and enthusiastic
- Make the student WANT to respond
- This will be read aloud, so keep it natural and spoken-sounding
"""


async def suggest_topic(
    api_key: str,
    jpeg_base64: str,
    tts_model: str = "gemini-2.5-flash-preview-tts",
    tts_voice: str = "Puck",
) -> dict:
    """
    Two-step pipeline:
    1. Send photo to gemini-2.5-flash → get topic text
    2. Send text to gemini TTS model → get audio (24kHz 16-bit PCM)

    Returns: {"text": "...", "audio": "<base64 PCM>" or None}
    """
    client = genai.Client(api_key=api_key)
    image_bytes = base64.b64decode(jpeg_base64)

    # Step 1: Image → Text
    response = await client.aio.models.generate_content(
        model="gemini-2.5-flash",
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
            TOPIC_PROMPT,
        ],
    )

    text = response.text or ""
    logger.info(f"Topic suggested: {text[:80]}...")

    # Step 2: Text → Audio (Gemini TTS)
    audio_b64 = None
    try:
        tts_response = await client.aio.models.generate_content(
            model=tts_model,
            contents=f"Say in a friendly, enthusiastic, casual tone: {text}",
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=SpeechConfig(
                    voice_config=VoiceConfig(
                        prebuilt_voice_config=PrebuiltVoiceConfig(
                            voice_name=tts_voice,
                        )
                    )
                ),
            ),
        )
        pcm_data = tts_response.candidates[0].content.parts[0].inline_data.data
        # Handle raw bytes vs base64 string inconsistency
        if isinstance(pcm_data, bytes):
            audio_b64 = base64.b64encode(pcm_data).decode("utf-8")
        else:
            audio_b64 = pcm_data  # already base64 string
        logger.info("TTS audio generated successfully")
    except Exception as e:
        logger.warning(f"TTS generation failed, falling back to text-only: {e}")

    return {"text": text, "audio": audio_b64}
