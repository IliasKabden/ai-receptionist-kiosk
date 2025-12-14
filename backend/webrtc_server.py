from __future__ import annotations

import asyncio
import os
import tempfile
import uuid
import time
from pathlib import Path
from typing import Dict

from aiortc import RTCPeerConnection, RTCSessionDescription, MediaPlayer, MediaRecorder
from fastapi import APIRouter, HTTPException

from .services.stt_service import transcribe_audio
from .services.llm_service import generate_answer
from .services.tts_service import synthesize_speech
from .services.settings import MEDIA_DIR

router = APIRouter()

PCS: Dict[str, RTCPeerConnection] = {}


async def _process_received_audio(file_path: Path) -> str:
    # Try local whisper.cpp first if available, else fallback to transcribe_audio (OpenAI)
    from .tools import whisper_wrapper
    import subprocess
    import os

    # Optionally run RNNoise if binary present
    rnnoise_bin = os.getenv("RNNOISE_BIN", "")
    wav_path = file_path
    try:
        if rnnoise_bin:
            cleaned = file_path.with_suffix('.rn.wav')
            try:
                subprocess.run([rnnoise_bin, str(file_path), str(cleaned)], check=True, timeout=20)
                wav_path = cleaned
            except Exception as ex:
                print("RNNoise failed:", ex)

        if whisper_wrapper.is_available():
            text, conf = whisper_wrapper.transcribe_wav(str(wav_path))
            if text:
                return text

        # Fallback to existing transcribe_audio (expects a BinaryIO)
        with open(wav_path, "rb") as f:
            text = transcribe_audio(f, language="ru")
            return text
    except Exception as ex:
        print("Error during transcription:", ex)
        return ""


@router.post("/webrtc")
async def webrtc_offer(payload: Dict[str, str]):
    """
    Accepts an SDP offer from the browser, creates a PeerConnection,
    records incoming audio to a temporary file, then transcribes + generates
    answer + synthesizes speech and plays it back to the peer.

    This PoC uses temporary files for simplicity; in production you'd
    stream audio to an ASR engine and stream TTS audio back.
    """
    if "sdp" not in payload or "type" not in payload:
        raise HTTPException(status_code=400, detail="Missing sdp/type")

    offer = RTCSessionDescription(sdp=payload["sdp"], type=payload["type"]) 

    pc = RTCPeerConnection()
    pc_id = "pc-" + uuid.uuid4().hex[:8]
    PCS[pc_id] = pc

    temp_dir = Path(tempfile.gettempdir())

    @pc.on("track")
    def on_track(track):
        print(f"Incoming track kind={track.kind}")

        if track.kind == "audio":
            # record in short repeated chunks and process each quickly to reduce latency
            async def continuous_record_and_process():
                try:
                    while True:
                        out_file = temp_dir / f"recv_{pc_id}_{int(time.time()*1000)}.wav"
                        recorder = MediaRecorder(str(out_file))
                        await recorder.start()
                        recorder.addTrack(track)
                        # short chunk (1.5s) for low latency
                        await asyncio.sleep(1.5)
                        await recorder.stop()

                        # process chunk in background (do not block loop)
                        async def _proc(path):
                            user_text = await _process_received_audio(path)
                            print("WebRTC STT result:", repr(user_text))

                            if not user_text:
                                return

                            system_prompt = "Вы — вежливый виртуальный администратор ресепшена. Отвечай кратко на русском."
                            answer_text = generate_answer(system_prompt, [{"role": "user", "content": user_text}])
                            print("LLM answer:", answer_text)

                            uid = uuid.uuid4().hex[:8]
                            wav_path = synthesize_speech(answer_text, basename=f"webrtc_reply_{uid}")
                            if wav_path and wav_path.exists():
                                player = MediaPlayer(str(wav_path))
                                out_track = player.audio
                                if out_track:
                                    pc.addTrack(out_track)

                        asyncio.ensure_future(_proc(out_file))

                        # If track ended, break
                        if track.readyState == "ended":
                            break
                except Exception as ex:
                    print("continuous_record_and_process error:", ex)

            asyncio.ensure_future(continuous_record_and_process())

    # Set remote description and create answer
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type, "pc_id": pc_id}


@router.post("/webrtc_hangup")
async def webrtc_hangup(pc_id: str):
    pc = PCS.pop(pc_id, None)
    if pc:
        await pc.close()
        return {"status": "closed"}
    return {"status": "not_found"}
