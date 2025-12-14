from __future__ import annotations

import io
import uuid
import logging
from typing import Dict, Any
from pathlib import Path
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger(__name__)

from services.settings import (
    MEDIA_DIR,
    SYSTEM_PROMPT_KK,
    SYSTEM_PROMPT_RU,
    SYSTEM_PROMPT_EN,
    BASE_DIR,
)
from services.config_service import load_config, save_config
from services.stt_service import transcribe_audio
from services.llm_service import generate_answer
import sqlite3
from services.tts_service import synthesize_speech
from services.avatar_service import generate_talking_avatar
try:
    from webrtc_opus import webrtc_router
except Exception as e:  # PyAV may be unavailable
    print(f"[WARNING] WebRTC router not loaded: {e}")
    webrtc_router = None
try:
    from stream_server import router as stream_router
except Exception as e:
    print(f"[ERROR] Stream router failed to load: {e}")
    print("[ERROR] WebSocket streaming will not be available!")
    stream_router = None

app = FastAPI(title="AI Receptionist Backend (SadTalker + Piper + Lang)")
DB_PATH = BASE_DIR / "reception_logs.sqlite3"

def init_db():
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    started_at INTEGER,
                    ended_at INTEGER
                )
                """
        )
        cur.execute(
                """
                CREATE TABLE IF NOT EXISTS turns (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT,
                    ts INTEGER,
                    user_text TEXT,
                    answer_text TEXT,
                    department TEXT,
                    room TEXT,
                    floor TEXT,
                    contact TEXT
                )
                """
        )
        conn.commit()
        conn.close()

init_db()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount media and frontend directories
FRONTEND_DIR = BASE_DIR.parent / "frontend"
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")
if FRONTEND_DIR.exists():
    app.mount("/frontend", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
    print(f"[INFO] Frontend mounted at /frontend from {FRONTEND_DIR}")
else:
    print(f"[WARNING] Frontend directory not found: {FRONTEND_DIR}")

# WebRTC PoC routes (webrtc_router is optional)
if webrtc_router is not None:
    app.include_router(webrtc_router)
if stream_router is not None:
    app.include_router(stream_router)

@app.get("/", response_class=HTMLResponse)
async def root():
    return "<h2>AI Receptionist Backend is running</h2>"

@app.get("/api/config")
async def get_config():
    return load_config()

@app.post("/api/config")
async def update_config(cfg: Dict[str, Any]):
    current = load_config()
    current.update(cfg)
    save_config(current)
    return current

def build_system_prompt(language: str, extra_prompt: str) -> str:
    if language == "ru":
        base = SYSTEM_PROMPT_RU
    elif language == "en":
        base = SYSTEM_PROMPT_EN
    else:
        base = SYSTEM_PROMPT_KK

    extra = (extra_prompt or "").strip()
    # Instruct model to output routing JSON block if possible
    routing_hint = (
        "\n\nЕсли можешь определить направление для гостя, добавь в конце ответа JSON блок на новой строке строго в формате: "
        "{\"department\":string, \"room\":string, \"floor\":string, \"contact\":string}"
        " без комментариев."
    )
    if extra:
        return base + "\n\nДополнительные инструкции администратора:\n" + extra + routing_hint
    return base + routing_hint

@app.post("/api/dialogue")
async def dialogue(audio: UploadFile = File(...), session_id: str | None = None):
    cfg = load_config()
    language = cfg.get("language", "kk")
    avatar_mode = cfg.get("avatar_mode", "video")
    avatar_image_path = cfg.get("avatar_image_path", "")
    extra_prompt = cfg.get("extra_prompt", "")
    subtitles_enabled = cfg.get("subtitles_enabled", True)

    system_prompt = build_system_prompt(language, extra_prompt)

    raw = await audio.read()
    audio_io = io.BytesIO(raw)

    user_text = transcribe_audio(audio_io, language=language)
    
    # If STT returned empty (filtered hallucination or silence), return empty response
    if not user_text or not user_text.strip():
        logger.info("[Dialogue] Empty transcription, skipping response")
        return {
            "user_text": "",
            "answer_text": "",
            "audio_url": None,
            "avatar_video_url": None,
        }
    
    answer_text = generate_answer(system_prompt, [{"role": "user", "content": user_text}])

    # Try extract routing JSON at end of answer
    department = room = floor = contact = None
    try:
        import re, json as pyjson
        m = re.search(r"\{\s*\"department\".*\}\s*$", answer_text, re.S)
        if m:
            payload = pyjson.loads(m.group(0))
            department = (payload.get("department") or None)
            room = (payload.get("room") or None)
            floor = (payload.get("floor") or None)
            contact = (payload.get("contact") or None)
    except Exception:
        pass

    uid = uuid.uuid4().hex[:8]
    base_name = f"reply_{uid}"

    wav_path = synthesize_speech(answer_text, basename=base_name)

    audio_url = None
    avatar_video_url = None

    if wav_path and wav_path.exists():
        audio_url = f"/media/{wav_path.name}"

        if avatar_mode == "video" and avatar_image_path:
            video_path = generate_talking_avatar(
                source_image=Path(avatar_image_path),
                driven_audio=wav_path,
                basename=base_name,
            )
            if video_path and video_path.exists():
                rel = video_path.relative_to(MEDIA_DIR)
                avatar_video_url = f"/media/{rel.as_posix()}"

    # Log to SQLite
    try:
        import time
        sid = session_id or uuid.uuid4().hex[:8]
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("INSERT OR IGNORE INTO sessions(id, started_at) VALUES(?, ?)", (sid, int(time.time())))
        cur.execute(
            "INSERT INTO turns(session_id, ts, user_text, answer_text, department, room, floor, contact) VALUES(?,?,?,?,?,?,?,?)",
            (sid, int(time.time()), user_text, answer_text, department, room, floor, contact)
        )
        conn.commit()
        conn.close()
    except Exception as e:
        logger.warning(f"[Logging] Failed to log turn: {e}")

    return {
        "user_text": user_text,
        "answer_text": answer_text,
        "audio_url": audio_url,
        "avatar_video_url": avatar_video_url,
        "routing": {
            "department": department,
            "room": room,
            "floor": floor,
            "contact": contact,
        },
        "subtitles_enabled": subtitles_enabled,
    }

@app.get("/api/logs/export")
async def export_logs():
    # Simple export of all turns as JSON lines
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT session_id, ts, user_text, answer_text, department, room, floor, contact FROM turns ORDER BY ts ASC")
    rows = cur.fetchall()
    conn.close()
    import json as pyjson
    lines = []
    for r in rows:
        lines.append(pyjson.dumps({
            "session_id": r[0], "ts": r[1], "user_text": r[2], "answer_text": r[3],
            "department": r[4], "room": r[5], "floor": r[6], "contact": r[7]
        }, ensure_ascii=False))
    return HTMLResponse("\n".join(lines))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
