from pydantic import BaseModel
from typing import Literal


class ClientAudioMessage(BaseModel):
    type: Literal["audio"]
    data: str  # base64 encoded PCM


class ClientVideoMessage(BaseModel):
    type: Literal["video"]
    data: str  # base64 encoded JPEG


class ClientStartSession(BaseModel):
    type: Literal["start_session"]
    config: dict = {}


class ClientEndSession(BaseModel):
    type: Literal["end_session"]


class ServerAudioMessage(BaseModel):
    type: Literal["audio"] = "audio"
    data: str  # base64 encoded PCM


class ServerTranscriptMessage(BaseModel):
    type: Literal["transcript"] = "transcript"
    role: Literal["ai", "user"]
    content: str


class ServerCorrectionMessage(BaseModel):
    type: Literal["correction"] = "correction"
    original: str
    corrected: str
    rule: str


class ServerVocabularyMessage(BaseModel):
    type: Literal["vocabulary"] = "vocabulary"
    word: str
    definition: str
    example: str


class ServerStatusMessage(BaseModel):
    type: Literal["status"] = "status"
    status: Literal["ready", "reconnecting", "error"]
    message: str = ""
