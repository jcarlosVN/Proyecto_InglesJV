"""
REST endpoint for Passive Mode topic suggestions.
Receives a single JPEG frame and returns an English topic suggestion.
"""

import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from config import settings
from services.topic_suggester import suggest_topic

logger = logging.getLogger(__name__)
router = APIRouter()


class TopicRequest(BaseModel):
    image: str  # base64-encoded JPEG


class TopicResponse(BaseModel):
    text: str


@router.post("/api/suggest-topic", response_model=TopicResponse)
async def suggest_topic_endpoint(req: TopicRequest):
    try:
        result = await suggest_topic(settings.GEMINI_API_KEY, req.image)
        return TopicResponse(text=result["text"])
    except Exception as e:
        logger.error(f"Topic suggestion failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
