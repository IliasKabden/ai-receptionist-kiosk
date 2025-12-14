from __future__ import annotations

from typing import List, Dict
from openai import OpenAI
from .settings import OPENAI_API_KEY, OPENAI_MODEL

_client: OpenAI | None = None

def get_client() -> OpenAI:
    global _client
    if _client is None:
        if not OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is not set")
        _client = OpenAI(api_key=OPENAI_API_KEY)
    return _client

def generate_answer(system_prompt: str, messages: List[Dict[str, str]]) -> str:
    client = get_client()
    full_messages = [{"role": "system", "content": system_prompt}] + messages

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=full_messages,
        temperature=0.4,
    )
    return resp.choices[0].message.content.strip()
