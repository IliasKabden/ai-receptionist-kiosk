from __future__ import annotations

import io
import logging
from typing import BinaryIO
from openai import OpenAI
from .settings import OPENAI_API_KEY

logger = logging.getLogger(__name__)

_client: OpenAI | None = None


def get_client() -> OpenAI:
    global _client
    if _client is None:
        if not OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is not set")
        _client = OpenAI(api_key=OPENAI_API_KEY)
    return _client


def transcribe_audio(audio_file: BinaryIO, language: str | None = None) -> str:
    """
    Распознаём РУССКИЙ через whisper-1.
    Без всяких авто-языков, без казахского, только RU.
    """
    client = get_client()

    # На всякий случай перематываем на начало
    if hasattr(audio_file, "seek"):
        audio_file.seek(0)

    file_bytes = audio_file.read()
    audio_io = io.BytesIO(file_bytes)
    audio_io.name = "audio.webm"

    transcription = client.audio.transcriptions.create(
        model="whisper-1",
        file=audio_io,
        language="ru"
    )

    text = transcription.text or ""
    print("STT RAW TEXT:", repr(text))
    
    # Filter common Whisper hallucinations (YouTube captions, video outros, etc.)
    hallucination_keywords = [
        "субтитр", "dimaTorzok", "дубровск", "алексе",
        "спасибо за просмотр", "подпишитесь", "лайк", "канал", "ставь",
        "thanks for watching", "subscribe", "like", "comment",
        "с вами был", "игорь", "негода", "outro", "intro",
        "вопросы о встречах", "кабинетах", "сотрудниках",
        "музыка", "music", "♪", "♫",
        "продолжение следует", "продолжение", "следует",
        "понимаю", "хорошо"  # Too generic - Whisper loves these
    ]
    
    text_lower = text.lower()
    for keyword in hallucination_keywords:
        if keyword.lower() in text_lower:
            logger.warning(f"[STT] Hallucination detected: '{text}' contains '{keyword}'")
            return ""  # Return empty string instead of garbage
    
    # Reject too short transcriptions (likely noise)
    if len(text.strip()) < 3:
        logger.warning(f"[STT] Transcription too short: '{text}'")
        return ""
    
    return text.strip()
