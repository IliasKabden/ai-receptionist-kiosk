from __future__ import annotations

import asyncio
import subprocess
import tempfile
import time
import wave
import json
import logging
import re
from io import BytesIO
from pathlib import Path
from typing import Optional, Dict, Any

import numpy as np
import webrtcvad
from dotenv import load_dotenv

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.stt_service import transcribe_audio
from services.llm_service import generate_answer
from services.tts_service import synthesize_speech
from services.coqui_tts_service import synthesize_pcm_bytes, available as coqui_available
from services.avatar_service import generate_talking_avatar
from services.settings import MEDIA_DIR
from tools import whisper_wrapper
import os

# Load environment variables
load_dotenv()

# OpenAI setup
try:
    from openai import OpenAI
    OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
    OPENAI_CHAT_MODEL = os.getenv("OPENAI_CHAT_MODEL", "gpt-4o-mini")
    OPENAI_ASR_MODEL = os.getenv("OPENAI_ASR_MODEL", "whisper-1")
    OPENAI_TTS_MODEL = os.getenv("OPENAI_TTS_MODEL", "tts-1")
    OPENAI_TTS_VOICE = os.getenv("OPENAI_TTS_VOICE", "nova")
    OPENAI_MAX_TOKENS = int(os.getenv("OPENAI_MAX_TOKENS", "800"))
    OPENAI_TEMPERATURE = float(os.getenv("OPENAI_TEMPERATURE", "0.2"))
    USE_OPENAI_STT = os.getenv("USE_OPENAI_STT", "true").lower() == "true"
    USE_OPENAI_LLM = os.getenv("USE_OPENAI_LLM", "true").lower() == "true"
    USE_OPENAI_TTS = os.getenv("USE_OPENAI_TTS", "true").lower() == "true"
    
    OPENAI_AVAILABLE = bool(OPENAI_API_KEY)
    if OPENAI_AVAILABLE:
        openai_client = OpenAI(api_key=OPENAI_API_KEY)
        logging.info("[OpenAI] Initialized successfully")
    else:
        openai_client = None
        logging.warning("[OpenAI] API key not set, using fallback services")
except Exception as ex:
    openai_client = None
    OPENAI_AVAILABLE = False
    USE_OPENAI_STT = False
    USE_OPENAI_LLM = False
    USE_OPENAI_TTS = False
    logging.warning(f"[OpenAI] Import failed: {ex}")

router = APIRouter()

VAD = webrtcvad.Vad(0)  # aggressiveness 0-3 (0=least aggressive, more sensitive to speech)


def openai_transcribe_audio(audio_bytes: bytes, language: str = "ru") -> str:
    """Transcribe audio using OpenAI Whisper API"""
    if not OPENAI_AVAILABLE or not USE_OPENAI_STT or not openai_client:
        return ""
    
    try:
        audio_io = BytesIO(audio_bytes)
        audio_io.name = "audio.webm"
        
        transcription = openai_client.audio.transcriptions.create(
            model=OPENAI_ASR_MODEL,
            file=audio_io,
            language=language
        )
        
        text = transcription.text or ""
        logging.info(f"[OpenAI STT] Transcribed: {text[:100]}...")
        return text.strip()
    except Exception as ex:
        logging.exception(f"[OpenAI STT] Failed: {ex}")
        return ""


def openai_llm_with_functions(user_text: str) -> Dict[str, Any]:
    """Generate response with emotion and gesture using OpenAI function calling"""
    default = {"text": user_text, "emotion": "neutral", "gesture": "none"}
    
    if not OPENAI_AVAILABLE or not USE_OPENAI_LLM or not openai_client:
        return default
    
    system_prompt = (
        "Ты — вежливый виртуальный администратор ресепшена. "
        "Отвечай кратко и по делу на русском языке. "
        "Верни ответ через функцию extract_response с полями: text, emotion, gesture."
    )
    
    functions = [
        {
            "name": "extract_response",
            "description": "Возвращает ответ с эмоцией и жестом",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Текст ответа"},
                    "emotion": {
                        "type": "string",
                        "enum": ["happy", "sad", "thinking", "surprised", "neutral"],
                        "description": "Эмоция для аватара"
                    },
                    "gesture": {
                        "type": "string",
                        "enum": ["wave", "point", "none"],
                        "description": "Жест для аватара"
                    }
                },
                "required": ["text", "emotion", "gesture"]
            }
        }
    ]
    
    try:
        response = openai_client.chat.completions.create(
            model=OPENAI_CHAT_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_text}
            ],
            functions=functions,
            function_call="auto",
            temperature=OPENAI_TEMPERATURE,
            max_tokens=OPENAI_MAX_TOKENS
        )
        
        message = response.choices[0].message
        
        # Check for function call
        if message.function_call:
            try:
                args = json.loads(message.function_call.arguments)
                result = {
                    "text": args.get("text", user_text).strip(),
                    "emotion": args.get("emotion", "neutral"),
                    "gesture": args.get("gesture", "none")
                }
                logging.info(f"[OpenAI LLM] Response: {result}")
                return result
            except json.JSONDecodeError as ex:
                logging.error(f"[OpenAI LLM] JSON parse error: {ex}")
        
        # Fallback: parse from content
        content = message.content or ""
        emotion_match = re.search(r"\[emotion:\s*(\w+)\]", content)
        gesture_match = re.search(r"\[gesture:\s*(\w+)\]", content)
        
        emotion = emotion_match.group(1) if emotion_match else "neutral"
        gesture = gesture_match.group(1) if gesture_match else "none"
        clean_text = re.sub(r"\[emotion:.*?\]|\[gesture:.*?\]", "", content).strip()
        
        return {
            "text": clean_text or user_text,
            "emotion": emotion,
            "gesture": gesture
        }
    
    except Exception as ex:
        logging.exception(f"[OpenAI LLM] Failed: {ex}")
        return default


def openai_synthesize_speech(text: str, output_path: Path) -> bool:
    """Synthesize speech using OpenAI TTS API"""
    if not OPENAI_AVAILABLE or not USE_OPENAI_TTS or not openai_client:
        return False
    
    try:
        response = openai_client.audio.speech.create(
            model=OPENAI_TTS_MODEL,
            voice=OPENAI_TTS_VOICE,
            input=text
        )
        
        response.stream_to_file(str(output_path))
        logging.info(f"[OpenAI TTS] Generated: {output_path}")
        return True
    except Exception as ex:
        logging.exception(f"[OpenAI TTS] Failed: {ex}")
        return False


def detect_emotion_from_text(text: str) -> str:
    """Simple emotion detection based on keywords"""
    text_lower = text.lower()
    
    # Check for emotions
    if any(word in text_lower for word in ['привет', 'здравствуйте', 'рад', 'добро пожаловать', 'приятно']):
        return 'happy'
    elif any(word in text_lower for word in ['извините', 'прошу прощения', 'к сожалению', 'жаль']):
        return 'sad'
    elif any(word in text_lower for word in ['подожд', 'минут', 'секунд', 'сейчас', 'проверю']):
        return 'thinking'
    elif any(word in text_lower for word in ['удивлен', 'неожиданно', 'действительно', 'правда']):
        return 'surprised'
    else:
        return 'neutral'


def detect_gesture_from_text(text: str) -> str | None:
    """Simple gesture detection based on context"""
    text_lower = text.lower()
    
    if any(word in text_lower for word in ['привет', 'здравствуйте', 'добро пожаловать']):
        return 'wave'
    elif any(word in text_lower for word in ['направо', 'налево', 'туда', 'сюда', 'там']):
        return 'point'
    else:
        return None


# Simple helper: convert webm bytes to raw PCM 16k mono wav bytes using ffmpeg
def webm_to_pcm_wav_bytes(webm_path: Path, sample_rate: int = 16000) -> Optional[bytes]:
    try:
        # ffmpeg -i in.webm -ar 16000 -ac 1 -f wav pipe:1
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(webm_path),
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            "-f",
            "wav",
            "pipe:1",
        ]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        out, _ = p.communicate()
        return out
    except Exception as ex:
        print("ffmpeg convert error:", ex)
        return None


def frames_from_pcm(pcm_bytes: bytes, frame_duration_ms: int = 30, sample_rate: int = 16000):
    bytes_per_sample = 2
    frame_bytes = int(sample_rate * bytes_per_sample * (frame_duration_ms / 1000.0))
    for i in range(0, len(pcm_bytes), frame_bytes):
        yield pcm_bytes[i : i + frame_bytes]


async def process_buffer_and_respond(ws: WebSocket, pcm_buffer: bytes):
    # write pcm_buffer to a temporary wav file, then convert to webm for transcribe_audio
    start_all = time.time()
    print(f"[stream] processing buffer len={len(pcm_buffer)} bytes")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        wav_path = Path(tf.name)
        with wave.open(str(wav_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(pcm_buffer)
    # Optionally run RNNoise native binary if provided (in-place: input wav -> output wav)
    rnnoise_bin = os.getenv("RNNOISE_BIN", "")
    if rnnoise_bin:
        try:
            cleaned = wav_path.with_suffix(".rn.wav")
            cmd = [rnnoise_bin, str(wav_path), str(cleaned)]
            subprocess.run(cmd, check=True)
            # replace wav_path with cleaned
            try:
                wav_path.unlink()
            except Exception:
                pass
            wav_path = cleaned
        except Exception as ex:
            print("RNNoise processing failed:", ex)

    # Try whisper.cpp wrapper first (local OSS ASR), fallback to existing transcribe_audio (OpenAI)
    user_text = ""
    confidence = None
    try:
        if whisper_wrapper.is_available():
            t0 = time.time()
            text, conf = whisper_wrapper.transcribe_wav(str(wav_path))
            print(f"[stream] whisper_wrapper took {time.time()-t0:.2f}s")
            if text:
                user_text = text
                confidence = conf
    except Exception as ex:
        print("whisper wrapper error:", ex)

    if not user_text:
        # Try OpenAI Whisper API first if enabled
        if USE_OPENAI_STT and OPENAI_AVAILABLE:
            try:
                # Convert wav to webm for OpenAI
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(wav_path),
                    "-c:a",
                    "libopus",
                    "-b:a",
                    "32k",
                    "-vbr",
                    "on",
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-f",
                    "webm",
                    "pipe:1",
                ]
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                webm_bytes, _ = p.communicate()
                
                if webm_bytes:
                    user_text = openai_transcribe_audio(webm_bytes, language="ru")
                    print(f"[stream] OpenAI STT took {time.time()-start_all:.2f}s")
            except Exception as ex:
                print("OpenAI STT error:", ex)
        
        # Fallback to existing service if OpenAI failed or disabled
        if not user_text:
            # convert wav -> webm (opus) for OpenAI whisper API compatibility
            webm_bytes = None
            try:
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(wav_path),
                    "-c:a",
                    "libopus",
                    "-b:a",
                    "32k",
                    "-vbr",
                    "on",
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-f",
                    "webm",
                    "pipe:1",
                ]
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                out, _ = p.communicate()
                webm_bytes = out
                print(f"[stream] ffmpeg wav->webm took {time.time()-start_all:.2f}s")
            except Exception as ex:
                print("ffmpeg to webm error:", ex)

            # cleanup wav temp
            try:
                wav_path.unlink()
            except Exception:
                pass

            if not webm_bytes:
                await ws.send_json({"error": "conversion_failed"})
                return

            # Call transcribe_audio which expects a BinaryIO
            audio_io = BytesIO(webm_bytes)
            try:
                user_text = transcribe_audio(audio_io, language="ru")
            except Exception as ex:
                print("transcription error:", ex)
                user_text = ""

    # Send back interim user_text
    await ws.send_json({"type": "user_text", "text": user_text})

    # If we have a confidence score and it's low, ask user to repeat instead of calling LLM
    try:
        conf_threshold = float(os.getenv("ASR_CONFIDENCE_THRESHOLD", "0.6"))
    except Exception:
        conf_threshold = 0.6

    if confidence is not None and confidence < conf_threshold:
        await ws.send_json({"type": "clarify", "text": "Извините, не расслышал. Повторите, пожалуйста."})
        return

    # Generate answer with OpenAI if enabled, fallback to local LLM
    answer_text = ""
    emotion = "neutral"
    gesture = "none"
    
    if USE_OPENAI_LLM and OPENAI_AVAILABLE:
        try:
            result = openai_llm_with_functions(user_text)
            answer_text = result["text"]
            emotion = result["emotion"]
            gesture = result["gesture"]
            print(f"[stream] OpenAI LLM generated answer with emotion/gesture: took {time.time()-start_all:.2f}s")
        except Exception as ex:
            print("OpenAI LLM error:", ex)
    
    # Fallback to local LLM if OpenAI failed or disabled
    if not answer_text:
        system_prompt = "Вы — вежливый виртуальный администратор ресепшена. Отвечай кратко на русском."
        try:
            answer_text = generate_answer(system_prompt, [{"role": "user", "content": user_text}])
        except Exception as ex:
            print("LLM error:", ex)
            answer_text = "Извините, ошибка обработки."
        
        print(f"[stream] LLM generated answer (len {len(answer_text)}): took {time.time()-start_all:.2f}s total so far")
        
        # Detect emotion and gesture for avatar using local detection
        emotion = detect_emotion_from_text(answer_text)
        gesture = detect_gesture_from_text(answer_text) or "none"

    # Synthesize audio
    uid = int(time.time() * 1000) % 100000
    wav_path = None
    
    # Try OpenAI TTS first if enabled
    if USE_OPENAI_TTS and OPENAI_AVAILABLE:
        try:
            temp_path = MEDIA_DIR / f"openai_stream_reply_{uid}.wav"
            if openai_synthesize_speech(answer_text, temp_path):
                wav_path = temp_path
                print(f"[stream] OpenAI TTS generated: took {time.time()-start_all:.2f}s")
        except Exception as ex:
            print("OpenAI TTS error:", ex)
    
    # Fallback to existing TTS if OpenAI failed or disabled
    if not wav_path:
        wav_path = synthesize_speech(answer_text, basename=f"stream_reply_{uid}")

    # send answer text to client with emotion/gesture metadata
    await ws.send_json({
        "type": "answer", 
        "text": answer_text,
        "emotion": emotion,
        "gesture": gesture
    })

    # Generate talking avatar video using SadTalker (async/background)
    video_url = None
    avatar_image = MEDIA_DIR / "avatar_photo.jpg"  # Match the filename user provided
    print(f"[stream] Checking avatar generation: avatar_image={avatar_image.exists()}, wav_path={wav_path}, wav_exists={wav_path.exists() if wav_path else False}")
    if avatar_image.exists() and wav_path and wav_path.exists():
        try:
            print(f"[stream] Starting SadTalker video generation...")
            # Generate video in background without blocking
            video_path = generate_talking_avatar(
                source_image=avatar_image,
                driven_audio=wav_path,
                basename=f"avatar_response_{uid}"
            )
            print(f"[stream] generate_talking_avatar returned: {video_path}")
            if video_path and video_path.exists():
                # Send video URL to client (assumes /media endpoint is mounted)
                video_url = f"/media/videos/{video_path.name}"
                await ws.send_json({
                    "type": "video_url",
                    "url": video_url
                })
                print(f"[stream] SadTalker video generated: {video_url} in {time.time()-start_all:.2f}s")
            else:
                print(f"[stream] Video path returned but file doesn't exist: {video_path}")
        except subprocess.TimeoutExpired:
            print(f"[stream] SadTalker timeout (>5 min), skipping video generation")
        except Exception as ex:
            print(f"[stream] SadTalker error: {ex}")
    else:
        print(f"[stream] Skipping SadTalker: avatar exists={avatar_image.exists()}, wav_path={wav_path is not None}")

    # Try Coqui TTS in-memory streaming first (if available and OpenAI not used)
    if not (USE_OPENAI_TTS and OPENAI_AVAILABLE) and coqui_available():
        try:
            out = synthesize_pcm_bytes(answer_text)
            if out:
                pcm_bytes, sr, nch, sw = out

                await ws.send_json({
                    "type": "audio_start",
                    "sampleRate": sr,
                    "channels": nch,
                    "sampleWidth": sw,
                    "emotion": emotion,
                    "gesture": gesture
                })

                chunk_ms = 200
                bytes_per_sample = sw
                chunk_bytes = int(sr * nch * bytes_per_sample * (chunk_ms / 1000.0))
                for i in range(0, len(pcm_bytes), chunk_bytes):
                    chunk = pcm_bytes[i : i + chunk_bytes]
                    try:
                        await ws.send_bytes(chunk)
                    except Exception:
                        break

                await ws.send_json({"type": "audio_end"})
                print(f"[stream] Coqui streaming finished, total time {time.time()-start_all:.2f}s")
                return
        except Exception as ex:
            print("Coqui streaming failed:", ex)

    # If Coqui not available or failed, fallback to existing file-based Piper synth and stream the WAV
    if wav_path and wav_path.exists():
        try:
            with wave.open(str(wav_path), "rb") as wr:
                sr = wr.getframerate()
                nch = wr.getnchannels()
                sw = wr.getsampwidth()
                pcm_bytes = wr.readframes(wr.getnframes())

            # inform client about incoming audio stream
            await ws.send_json({
                "type": "audio_start",
                "sampleRate": sr,
                "channels": nch,
                "sampleWidth": sw,
            })

            # stream in 200ms chunks
            chunk_ms = 200
            bytes_per_sample = sw
            chunk_bytes = int(sr * nch * bytes_per_sample * (chunk_ms / 1000.0))

            for i in range(0, len(pcm_bytes), chunk_bytes):
                chunk = pcm_bytes[i : i + chunk_bytes]
                try:
                    await ws.send_bytes(chunk)
                except Exception:
                    break

            await ws.send_json({"type": "audio_end"})
            print(f"[stream] File-based streaming finished, total time {time.time()-start_all:.2f}s")
        except Exception as ex:
            print("Error streaming audio:", ex)
    print(f"[stream] total processing time: {time.time()-start_all:.2f}s")


@router.websocket("/ws/stream")
async def websocket_stream(ws: WebSocket):
    # Log incoming connection info for debugging origin/headers issues
    try:
        headers = {k.decode(): v.decode() for k, v in ws.scope.get('headers', [])}
    except Exception:
        headers = {}
    client = ws.client
    print(f"Incoming WebSocket connection from {client}, headers={headers}")
    try:
        await ws.accept()
        print("WebSocket connected for streaming")
    except Exception as ex:
        print("WebSocket accept failed:", ex)
        raise

    # buffer for voiced PCM frames
    pcm_buffer = bytearray()
    last_voice_time = None
    
    # Buffer for accumulating WebM chunks before processing
    webm_chunk_buffer = bytearray()
    WEBM_CHUNK_SIZE = 50000  # Process when we have ~50KB of WebM data

    try:
        while True:
            msg = await ws.receive()
            if "type" in msg and msg["type"] == "websocket.disconnect":
                break

            # binary messages expected: webm blob bytes
            data = None
            if isinstance(msg, dict) and msg.get("bytes") is not None:
                data = msg.get("bytes")
            elif isinstance(msg, bytes):
                data = msg
            elif isinstance(msg, dict) and msg.get("data") is not None:
                data = msg.get("data")
            else:
                # FastAPI puts binary in 'bytes' property
                try:
                    data = msg["bytes"]
                except Exception:
                    data = None

            if not data:
                await asyncio.sleep(0.01)
                continue
            
            # Accumulate WebM chunks
            webm_chunk_buffer.extend(data)
            print(f"[stream] Received {len(data)} bytes from client, buffer now {len(webm_chunk_buffer)} bytes")
            
            # Only process when we have enough data
            if len(webm_chunk_buffer) < WEBM_CHUNK_SIZE:
                continue
            
            print(f"[stream] Processing accumulated {len(webm_chunk_buffer)} bytes of WebM data...")

            # write accumulated webm chunks to temp file and convert to wav PCM
            with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tf:
                tf.write(bytes(webm_chunk_buffer))
                webm_path = Path(tf.name)
            
            # Clear buffer for next accumulation
            webm_chunk_buffer = bytearray()

            wav_bytes = webm_to_pcm_wav_bytes(webm_path, sample_rate=16000)
            try:
                webm_path.unlink()
            except Exception:
                pass

            if not wav_bytes:
                print(f"[stream] WARNING: webm_to_pcm_wav_bytes returned empty for {len(data)} bytes input")
                continue

            # strip WAV header to get PCM frames
            try:
                with wave.open(BytesIO(wav_bytes), "rb") as wr:
                    pcm = wr.readframes(wr.getnframes())
            except Exception as ex:
                print("wav parse error", ex)
                continue

            # Optional denoise (if noisereduce available)
            try:
                import noisereduce as nr

                # convert bytes to numpy int16
                audio_np = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
                # simple noise reduce (may be slow)
                reduced = nr.reduce_noise(y=audio_np, sr=16000)
                # clip and convert back to int16
                reduced = np.clip(reduced, -32768, 32767).astype(np.int16)
                pcm = reduced.tobytes()
            except Exception:
                # noisereduce not available or failed -> continue with raw pcm
                pass

            # VAD: split into frames and test
            voiced = False
            frame_count = 0
            voice_frame_count = 0
            for frame in frames_from_pcm(pcm, frame_duration_ms=30, sample_rate=16000):
                if len(frame) < 10:
                    continue
                frame_count += 1
                try:
                    if VAD.is_speech(frame, 16000):
                        voiced = True
                        voice_frame_count += 1
                        pcm_buffer.extend(frame)
                        last_voice_time = time.time()
                    else:
                        # if recently had voice, add silence frame to buffer to preserve timing
                        if last_voice_time and (time.time() - last_voice_time) < 0.5:
                            pcm_buffer.extend(frame)
                except Exception as ex:
                    # VAD may raise on short frames
                    print(f"[stream] VAD error on frame: {ex}")
            
            if frame_count > 0:
                print(f"[stream] VAD processed {frame_count} frames, {voice_frame_count} voiced, buffer size={len(pcm_buffer)} bytes")

            # endpointing: if we had voice and now silence > threshold -> process buffer
            # Lowered thresholds: 0.3s silence, 6000 bytes min buffer (~375ms of audio at 16kHz)
            if last_voice_time and (time.time() - last_voice_time) > 0.3 and len(pcm_buffer) > 6000:
                print(f"[stream] Voice endpoint detected! Processing buffer of {len(pcm_buffer)} bytes...")
                # copy buffer and reset
                buffer_copy = bytes(pcm_buffer)
                pcm_buffer = bytearray()
                last_voice_time = None
                # process in background
                asyncio.ensure_future(process_buffer_and_respond(ws, buffer_copy))

    except WebSocketDisconnect:
        print("WebSocket disconnected")
    except Exception as ex:
        print("WebSocket error:", ex)
    finally:
        try:
            await ws.close()
        except Exception:
            pass