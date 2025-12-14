import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

env_path = BASE_DIR / ".env"
if env_path.exists():
    load_dotenv(env_path)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

PIPER_PYTHON = os.getenv("PIPER_PYTHON", "python")
PIPER_MODEL = os.getenv("PIPER_MODEL", "")

SADTALKER_PYTHON = os.getenv("SADTALKER_PYTHON", "")
SADTALKER_SCRIPT = os.getenv("SADTALKER_SCRIPT", "")
SADTALKER_WORKDIR = Path(os.getenv("SADTALKER_WORKDIR", str(BASE_DIR)))

MEDIA_DIR = BASE_DIR / "media"
MEDIA_DIR.mkdir(exist_ok=True)

SYSTEM_PROMPT_KK = """
Сен - сыпайы, сабырлы виртуалды ресепшн-көмекші.
Қонақты жылы қарсы ал, қай компания не бөлім керек екенін анықта,
қысқа, түсінікті, қазақ тілінде жауап бер.
Қажет болса, қай кабинетке/қай қабатқа бару керек екенін нақты түсіндір.
""".strip()

SYSTEM_PROMPT_RU = """
Ты — вежливый виртуальный администратор ресепшена.
Твоя задача — по‑доброму встретить гостя, уточнить цель визита,
подсказать, в какой отдел или кабинет ему пройти, и кратко отвечать на вопросы.
Отвечай КРАТКО и ПОНЯТНО, только на русском языке.
Не начинай ответ с формального приветствия, если пользователь уже что-то сказал
(например, короткая фраза или приветствие). Вместо повторного "Здравствуйте" —
отвечай прямо по существу или попроси уточнить, если фраза неясна.
Если гость спрашивает дорогу, давай простые и логичные инструкции.
""".strip()

SYSTEM_PROMPT_EN = """
You are a polite virtual front-desk assistant.
Greet visitors, clarify the purpose of their visit,
direct them to the correct department or room,
and answer basic questions briefly and clearly in English.
""".strip()

CONFIG_PATH = BASE_DIR / "config.json"
