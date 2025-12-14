from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path
from typing import Optional, Tuple

# Wrapper for whisper.cpp (ggml) CLI. Configure via env vars:
# WHISPER_CPP_BIN -> path to whisper.cpp executable (main)
# WHISPER_MODEL -> path to ggml model file

WHISPER_BIN = os.getenv("WHISPER_CPP_BIN", "")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "")


def is_available() -> bool:
    return bool(WHISPER_BIN and Path(WHISPER_BIN).exists() and WHISPER_MODEL and Path(WHISPER_MODEL).exists())


def _run_cmd(cmd, timeout=60) -> Tuple[str, str, int]:
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = p.communicate(timeout=timeout)
    return out.decode("utf-8", errors="ignore"), err.decode("utf-8", errors="ignore"), p.returncode


def transcribe_wav(wav_path: str) -> Tuple[Optional[str], Optional[float]]:
    """Call whisper.cpp (main) with conservative flags and attempt to parse transcript.

    Returns (text, confidence) where confidence may be None if not available.
    """
    if not is_available():
        return None, None

    try:
        # Common whisper.cpp usage (may vary by fork):
        # ./main -m model.bin -f file.wav -otxt
        cmd = [WHISPER_BIN, "-m", WHISPER_MODEL, "-f", wav_path, "-otxt"]
        out, err, code = _run_cmd(cmd, timeout=60)

        if code != 0:
            # Some builds print transcript to stderr or use different flags; try fallback
            cmd2 = [WHISPER_BIN, "-m", WHISPER_MODEL, "-f", wav_path]
            out2, err2, code2 = _run_cmd(cmd2, timeout=60)
            out = out2 or out

        # Try to extract a simple transcript: many builds write a text file next to wav
        # If out contains the transcription lines, take them; otherwise attempt to read *.txt
        text = None
        if out and len(out.strip()) > 0:
            text = out.strip()

        if not text:
            # look for a sidecar file like wav_path + ".txt"
            side = Path(wav_path).with_suffix(".txt")
            if side.exists():
                text = side.read_text(encoding="utf-8").strip()

        if not text:
            return None, None

        # whisper.cpp does not reliably expose confidence; return None for now
        return text, None
    except Exception:
        return None, None