from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Optional
from .settings import SADTALKER_PYTHON, SADTALKER_SCRIPT, SADTALKER_WORKDIR, MEDIA_DIR

def generate_talking_avatar(
    source_image: Path,
    driven_audio: Path,
    basename: str,
) -> Optional[Path]:
    if not SADTALKER_PYTHON or not SADTALKER_SCRIPT:
        print("SadTalker is not configured in .env")
        return None

    out_dir = MEDIA_DIR / "videos"
    out_dir.mkdir(exist_ok=True)
    
    # Use a temp output directory to avoid conflicts
    import tempfile
    temp_out = Path(tempfile.mkdtemp(prefix="sadtalker_"))
    
    cmd = [
        SADTALKER_PYTHON,
        SADTALKER_SCRIPT,
        "--driven_audio", str(driven_audio),
        "--source_image", str(source_image),
        "--result_dir", str(temp_out),
        "--still",
        "--enhancer", "gfpgan",
        "--face", "det_retinaface",
        "--save_frame",
    ]
    try:
        print(f"[avatar_service] Running SadTalker command...")
        result = subprocess.run(
            cmd,
            cwd=str(SADTALKER_WORKDIR),
            check=False,
            timeout=300,
            capture_output=True,
            text=True,
        )
        
        if result.returncode != 0:
            print(f"[avatar_service] SadTalker stderr: {result.stderr}")
            print(f"[avatar_service] SadTalker stdout: {result.stdout}")
            
    except subprocess.TimeoutExpired:
        print("[avatar_service] SadTalker timeout (>5 min)")
        return None
    except Exception as ex:
        print(f"[avatar_service] SadTalker subprocess error: {ex}")
        return None

    # Find generated video in temp directory
    videos = sorted(temp_out.glob("**/*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not videos:
        print(f"[avatar_service] No video generated in {temp_out}")
        import shutil
        shutil.rmtree(str(temp_out), ignore_errors=True)
        return None
    
    video_src = videos[0]
    target = out_dir / f"{basename}.mp4"
    
    try:
        # Copy video to final location
        import shutil
        shutil.copy(str(video_src), str(target))
        print(f"[avatar_service] Video copied to {target}")
    except Exception as ex:
        print(f"[avatar_service] Copy error: {ex}")
        target = video_src
    
    # Cleanup temp directory
    try:
        import shutil
        shutil.rmtree(str(temp_out), ignore_errors=True)
    except Exception:
        pass
    
    return target if target.exists() else None
