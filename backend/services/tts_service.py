from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Optional
from .settings import PIPER_PYTHON, PIPER_MODEL, MEDIA_DIR

logger = logging.getLogger(__name__)


def synthesize_speech(text: str, basename: str) -> Optional[Path]:
    """
    Use OpenAI TTS for multilingual support (Kazakh, Russian, English).
    Falls back to Piper if OpenAI fails.
    """
    print("[TTS] Raw text (repr):", repr(text))
    logger.debug("TTS raw text: %s", text)

    out_path = MEDIA_DIR / f"{basename}.wav"
    
    # Try OpenAI TTS first (supports Kazakh!)
    try:
        from openai import OpenAI
        from .settings import OPENAI_API_KEY
        
        if OPENAI_API_KEY:
            client = OpenAI(api_key=OPENAI_API_KEY)
            logger.info("[TTS] Using OpenAI TTS (multilingual)")
            
            response = client.audio.speech.create(
                model="tts-1",
                voice="nova",  # Female voice
                input=text
            )
            
            # Save to file
            response.stream_to_file(str(out_path))
            logger.info(f"[TTS] OpenAI TTS generated: {out_path}")
            return out_path
    except Exception as ex:
        logger.warning(f"[TTS] OpenAI TTS failed: {ex}, falling back to Piper")
    
    # Fallback to Piper
    if not PIPER_MODEL:
        print("Piper TTS: PIPER_MODEL is not configured")
        return None
    
    cmd = [
        PIPER_PYTHON,
        "-m",
        "piper",
        "--model",
        PIPER_MODEL,
        "--output-file",
        str(out_path),
    ]
    try:
        result = subprocess.run(
            cmd, 
            input=text.encode('utf-8'), 
            check=True,
            capture_output=True
        )
        logger.info(f"TTS generated: {out_path}")
        return out_path
    except Exception as ex:
        print("Piper TTS error:", ex)
        logger.exception("Piper TTS failed")
        return None
