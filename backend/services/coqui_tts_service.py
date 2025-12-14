from __future__ import annotations

import os
from typing import Optional, Tuple

try:
    from TTS.api import TTS
    import numpy as np
except Exception:
    TTS = None

# Coqui TTS wrapper. If Coqui is installed and model available, use it to synthesize
# audio in-memory (float32 numpy), convert to int16 PCM and return bytes.

_model_name = os.getenv("COQUI_TTS_MODEL", "tts_models/ru/v3/ru_v3")
_tts: Optional[object] = None


def available() -> bool:
    global TTS
    return TTS is not None


def _init():
    global _tts
    if _tts is None and TTS is not None:
        try:
            _tts = TTS(model_name=_model_name)
        except Exception:
            _tts = None


def synthesize_pcm_bytes(text: str) -> Optional[Tuple[bytes, int, int, int]]:
    """
    Synthesize text to PCM bytes (Int16LE), returning (pcm_bytes, sample_rate, channels, sample_width)
    or None if Coqui is not available or synthesis failed.
    """
    _init()
    if _tts is None:
        return None

    try:
        # tts.tts returns waveform as numpy array (float32) and sample rate in many builds
        wav = _tts.tts(text)
        # Some versions return tuple (wav, sr)
        if isinstance(wav, tuple) and len(wav) == 2:
            audio_np, sr = wav
        else:
            audio_np = wav
            sr = getattr(_tts, 'sample_rate', 22050)

        # ensure mono
        if audio_np.ndim > 1:
            audio_np = np.mean(audio_np, axis=1)

        # float32 [-1,1] -> int16
        audio_int16 = (audio_np * 32767.0).astype(np.int16)
        pcm_bytes = audio_int16.tobytes()
        return pcm_bytes, int(sr), 1, 2
    except Exception as ex:
        print('Coqui TTS synth error:', ex)
        return None
