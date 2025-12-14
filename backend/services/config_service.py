from __future__ import annotations

import json
from typing import Any, Dict
from .settings import CONFIG_PATH

DEFAULT_CONFIG: Dict[str, Any] = {
    "language": "kk",
    "extra_prompt": "",
    "avatar_mode": "video",
    "avatar_image_path": "",
    "subtitles_enabled": True,
    # Presence detection settings
    "presence": {
        "enabled": True,
        "sensitivity": 0.7,  # 0..1, higher = stricter (needs closer/clearer face)
        "roi": {  # region of interest as percentages 0..1
            "top": 0.0,
            "left": 0.0,
            "width": 1.0,
            "height": 1.0,
        },
        "attentionTolerancePx": 80,  # nose-to-mid-eye offset tolerance
        "nearThreshold": 0.10,
        "mediumThreshold": 0.07,
        "holdMs": 20000
    }
}

def load_config() -> Dict[str, Any]:
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG.copy()
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        cfg = DEFAULT_CONFIG.copy()
        cfg.update(data)
        return cfg
    except Exception:
        return DEFAULT_CONFIG.copy()

def save_config(cfg: Dict[str, Any]) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
