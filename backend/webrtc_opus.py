"""
Simple WebRTC audio endpoint using PyAV for Opus decoding.
No aiortc dependency - just WebSocket + PyAV.
"""

import io
import logging
import uuid
from pathlib import Path
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import webrtcvad

# Import services
from services.stt_service import transcribe_audio
from services.llm_service import generate_answer
from services.tts_service import synthesize_speech
from services.settings import MEDIA_DIR, SYSTEM_PROMPT_KK, SYSTEM_PROMPT_RU

logger = logging.getLogger(__name__)

webrtc_router = APIRouter()

# VAD for voice detection
VAD = webrtcvad.Vad(0)  # Most sensitive

class OpusAudioBuffer:
    """Accumulates Opus frames and processes them."""
    
    def __init__(self):
        self.frames = []
        self.voiced_frames = 0
        self.total_frames = 0
        
    def add_pcm_frame(self, pcm_data: bytes, sample_rate: int = 16000):
        """Add PCM frame (10, 20, or 30ms) and run VAD."""
        frame_duration = len(pcm_data) // (sample_rate // 1000 * 2)  # 2 bytes per sample
        
        # VAD requires 10, 20, or 30ms frames
        if frame_duration not in [10, 20, 30]:
            return
            
        try:
            is_speech = VAD.is_speech(pcm_data, sample_rate)
            self.total_frames += 1
            if is_speech:
                self.voiced_frames += 1
                self.frames.append(pcm_data)
        except Exception as e:
            logger.error(f"VAD error: {e}")
    
    def get_audio(self) -> bytes:
        """Get accumulated audio."""
        if not self.frames:
            return b""
        return b"".join(self.frames)
    
    def clear(self):
        """Clear buffer."""
        self.frames = []
        self.voiced_frames = 0
        self.total_frames = 0


@webrtc_router.websocket("/webrtc/audio")
async def webrtc_audio_websocket(websocket: WebSocket):
    """
    WebSocket endpoint for receiving raw Opus audio.
    Client sends: binary Opus frames
    Server processes with VAD and responds when speech detected.
    """
    await websocket.accept()
    logger.info("[WebRTC] Client connected")
    
    buffer = OpusAudioBuffer()
    
    try:
        # Try to import PyAV for Opus decoding
        try:
            import av
            logger.info("[WebRTC] Using PyAV for Opus decoding")
            
            # Create in-memory Opus decoder
            def decode_opus(opus_data: bytes) -> bytes:
                """Decode Opus to PCM using PyAV."""
                try:
                    container = av.open(io.BytesIO(opus_data), format='ogg')
                    pcm_frames = []
                    
                    for frame in container.decode(audio=0):
                        # Resample to 16kHz mono if needed
                        frame = frame.reformat(format='s16', layout='mono', rate=16000)
                        pcm_frames.append(frame.to_ndarray().tobytes())
                    
                    return b"".join(pcm_frames)
                except Exception as e:
                    logger.error(f"Opus decode error: {e}")
                    return b""
            
        except ImportError:
            logger.warning("[WebRTC] PyAV not installed, using raw PCM")
            decode_opus = None
        
        while True:
            data = await websocket.receive_bytes()
            logger.debug(f"[WebRTC] Received {len(data)} bytes")
            
            # Decode Opus if available, otherwise assume PCM
            if decode_opus:
                pcm_data = decode_opus(data)
            else:
                pcm_data = data
            
            if not pcm_data:
                continue
            
            # Process in 20ms chunks for VAD
            CHUNK_SIZE = 640  # 20ms at 16kHz = 320 samples * 2 bytes
            for i in range(0, len(pcm_data), CHUNK_SIZE):
                chunk = pcm_data[i:i + CHUNK_SIZE]
                if len(chunk) == CHUNK_SIZE:
                    buffer.add_pcm_frame(chunk, 16000)
            
            # Check if we have enough speech (higher threshold to avoid false triggers)
            if buffer.voiced_frames > 50:  # ~1 second minimum
                logger.info(f"[WebRTC] Speech detected: {buffer.voiced_frames} frames")
                
                audio_bytes = buffer.get_audio()
                audio_duration = len(audio_bytes) / (16000 * 2)  # seconds
                
                # Reject too short audio (noise/hallucinations)
                if audio_duration < 0.8:
                    logger.warning(f"[WebRTC] Audio too short ({audio_duration:.2f}s), ignoring")
                    buffer.clear()
                    continue
                
                # Check audio energy (RMS) to reject silence/noise
                import array
                samples = array.array('h', audio_bytes)  # 16-bit signed integers
                rms = (sum(s*s for s in samples) / len(samples)) ** 0.5
                logger.info(f"[WebRTC] Audio RMS: {rms:.2f}")
                
                if rms < 200:  # Too quiet - likely silence or noise
                    logger.warning(f"[WebRTC] Audio too quiet (RMS={rms:.2f}), ignoring")
                    buffer.clear()
                    continue
                
                logger.info(f"[WebRTC] Processing {len(audio_bytes)} bytes ({audio_duration:.2f}s, RMS={rms:.2f})")
                
                # Save to WAV file for STT
                import wave
                base_name = f"webrtc_{uuid.uuid4().hex[:8]}"
                wav_path = MEDIA_DIR / f"{base_name}.wav"
                
                try:
                    with wave.open(str(wav_path), 'wb') as wf:
                        wf.setnchannels(1)
                        wf.setsampwidth(2)  # 16-bit
                        wf.setframerate(16000)
                        wf.writeframes(audio_bytes)
                    
                    logger.info(f"[WebRTC] Saved audio to {wav_path}")
                    
                    # 1. STT: Transcribe audio
                    with open(wav_path, 'rb') as f:
                        user_text = transcribe_audio(f, language="kk")
                    
                    logger.info(f"[WebRTC] STT result: {user_text}")
                    
                    if user_text and user_text.strip():
                        # 2. LLM: Generate answer
                        answer_text = generate_answer(
                            system_prompt=SYSTEM_PROMPT_KK,
                            messages=[{"role": "user", "content": user_text}]
                        )
                        
                        logger.info(f"[WebRTC] LLM answer: {answer_text}")
                        
                        # 3. TTS: Synthesize speech
                        tts_wav_path = synthesize_speech(answer_text, basename=base_name)
                        
                        if tts_wav_path and tts_wav_path.exists():
                            audio_url = f"/media/{tts_wav_path.name}"
                            logger.info(f"[WebRTC] TTS audio ready: {audio_url}")
                            
                            # Send complete response
                            await websocket.send_json({
                                "status": "complete",
                                "user_text": user_text,
                                "answer_text": answer_text,
                                "audio_url": audio_url
                            })
                        else:
                            logger.error("[WebRTC] TTS failed")
                            await websocket.send_json({"status": "error", "message": "TTS failed"})
                    else:
                        logger.warning("[WebRTC] Empty transcription")
                        await websocket.send_json({"status": "error", "message": "No speech detected"})
                    
                except Exception as e:
                    logger.error(f"[WebRTC] Processing error: {e}", exc_info=True)
                    await websocket.send_json({"status": "error", "message": str(e)})
                
                buffer.clear()
    
    except WebSocketDisconnect:
        logger.info("[WebRTC] Client disconnected")
    except Exception as e:
        logger.error(f"[WebRTC] Error: {e}", exc_info=True)
        await websocket.close()


@webrtc_router.get("/webrtc/status")
async def webrtc_status():
    """Check if WebRTC is available."""
    try:
        import av
        return {"status": "ok", "opus_decoder": "PyAV"}
    except ImportError:
        return {"status": "ok", "opus_decoder": "none", "note": "Install PyAV: pip install av"}
