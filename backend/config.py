from pathlib import Path
from pydantic_settings import BaseSettings

# Look for .env in backend/ first, then in app/ (parent directory)
_backend_dir = Path(__file__).resolve().parent
_env_file = _backend_dir / ".env"
if not _env_file.exists():
    _env_file = _backend_dir.parent / ".env"


class Settings(BaseSettings):
    GEMINI_API_KEY: str
    OPENAI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-2.5-flash-native-audio-preview-12-2025"
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    class Config:
        env_file = str(_env_file)
        env_file_encoding = "utf-8"


settings = Settings()
