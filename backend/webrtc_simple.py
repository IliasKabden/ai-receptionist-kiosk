"""
Simple WebRTC audio handler for Opus codec
Uses aiortc for WebRTC and handles Opus audio directly
"""
from fastapi import APIRouter, WebSocket
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from aiortc.contrib.media import MediaRecorder, MediaPlayer
from av import AudioFrame
import asyncio
import numpy as np
import time
from pathlib import Path
import tempfile
import wave

from services.stt_service import transcribe_audio
from services.llm_service import generate_answer
from services.tts_service import synthesize_speech
from services.settings import MEDIA_DIR

router = APIRouter()

# Store active peer connections
pcs = {}

class AudioReceiver:
    """Receives audio from WebRTC track and accumulates it"""
    
    def __init__(self):
        self.frames = []
        self.sample_rate = 48000  # Opus default
        self.is_recording = False
        
    async def receive_frame(self, frame: AudioFrame):
        """Called for each audio frame from WebRTC"""
        if not self.is_recording:
            return
            
        # Convert frame to numpy array
        audio_data = frame.to_ndarray()
        self.frames.append(audio_data)
        
    def get_audio_wav(self) -> bytes:
        """Export accumulated audio as WAV bytes"""
        if not self.frames:
            return None
            
        # Concatenate all frames
        audio_np = np.concatenate(self.frames, axis=1)
        
        # Convert to int16
        audio_int16 = (audio_np * 32767).astype(np.int16)
        
        # Create WAV file in memory
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            wav_path = Path(f.name)
            with wave.open(str(wav_path), 'wb') as wav_file:
                wav_file.setnchannels(1)  # Mono
                wav_file.setsampwidth(2)  # 16-bit
                wav_file.setframerate(self.sample_rate)
                wav_file.writeframes(audio_int16.tobytes())
        
        # Read back as bytes
        wav_bytes = wav_path.read_bytes()
        wav_path.unlink()
        
        return wav_bytes
    
    def clear(self):
        """Clear accumulated frames"""
        self.frames = []


@router.post("/webrtc/offer")
async def webrtc_offer(data: dict):
    """
    Handle WebRTC offer from client
    Returns answer SDP
    """
    pc = RTCPeerConnection()
    pc_id = str(id(pc))
    pcs[pc_id] = pc
    
    # Create audio receiver
    receiver = AudioReceiver()
    
    @pc.on("track")
    async def on_track(track: MediaStreamTrack):
        print(f"[WebRTC] Received {track.kind} track")
        
        if track.kind == "audio":
            receiver.is_recording = True
            
            # Start receiving frames
            while True:
                try:
                    frame = await track.recv()
                    await receiver.receive_frame(frame)
                except Exception as e:
                    print(f"[WebRTC] Track ended: {e}")
                    break
    
    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        print(f"[WebRTC] Connection state: {pc.connectionState}")
        
        if pc.connectionState == "failed" or pc.connectionState == "closed":
            await pc.close()
            pcs.pop(pc_id, None)
    
    # Set remote description (offer from client)
    offer = RTCSessionDescription(sdp=data["sdp"], type=data["type"])
    await pc.setRemoteDescription(offer)
    
    # Create answer
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    
    return {
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type,
        "pc_id": pc_id
    }


@router.post("/webrtc/process")
async def webrtc_process_audio(data: dict):
    """
    Process accumulated audio from WebRTC connection
    Called when user stops speaking
    """
    pc_id = data.get("pc_id")
    
    if pc_id not in pcs:
        return {"error": "Invalid pc_id"}
    
    pc = pcs[pc_id]
    
    # Get accumulated audio (this is a simplified version)
    # In real implementation, we'd store receiver reference
    
    # For now, return error - need to refactor to store receivers
    return {"error": "Not implemented yet - need to store receivers"}


@router.post("/webrtc/close")
async def webrtc_close(data: dict):
    """Close WebRTC connection"""
    pc_id = data.get("pc_id")
    
    if pc_id in pcs:
        pc = pcs[pc_id]
        await pc.close()
        pcs.pop(pc_id)
        return {"status": "closed"}
    
    return {"error": "Invalid pc_id"}
