# Установка проекта с OpenAI (максимальная интеграция)

## Что используется из OpenAI

✅ **STT (Speech-to-Text)** - Whisper API для распознавания речи  
✅ **LLM (Language Model)** - GPT-4o-mini с function calling для генерации ответов + emotion/gesture  
✅ **TTS (Text-to-Speech)** - OpenAI TTS API для синтеза речи  
✅ **Emotion Detection** - через function calling в GPT  
✅ **Gesture Detection** - через function calling в GPT  

## Требования

### 1. Установите необходимое ПО

#### Windows (PowerShell)
```powershell
# Git
winget install Git.Git

# Python 3.10+
winget install Python.Python.3.11

# Node.js (опционально для фронтенда)
winget install OpenJS.NodeJS.LTS

# ffmpeg (для аудио конвертации)
winget install Gyan.FFmpeg

# Git LFS (если большие модели в репозитории)
git lfs install
```

#### Проверка установки
```powershell
git --version
python --version
ffmpeg -version
```

### 2. Клонируйте и настройте проект

```powershell
# Перейдите в папку проекта
cd C:\Users\User\Desktop\MO\ai_receptionist_sadtalker_langfix\ai_receptionist_sadtalker_langfix\ai_receptionist_sadtalker_langfix

# Создайте виртуальное окружение
python -m venv .venv

# Активируйте
.venv\Scripts\Activate.ps1

# Обновите pip
pip install --upgrade pip

# Установите зависимости
pip install -r backend/requirements.txt
```

### 3. Настройте OpenAI API ключ

Откройте `backend/.env` и проверьте/обновите:

```env
# OpenAI API (ОБЯЗАТЕЛЬНО!)
OPENAI_API_KEY=sk-proj-ваш_ключ_здесь
OPENAI_MODEL=gpt-4o-mini
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_ASR_MODEL=whisper-1
OPENAI_TTS_MODEL=tts-1
OPENAI_TTS_VOICE=nova
OPENAI_MAX_TOKENS=800
OPENAI_TEMPERATURE=0.2

# Управление (можно включить/выключить каждый сервис)
USE_OPENAI_STT=true
USE_OPENAI_LLM=true
USE_OPENAI_TTS=true

# Локальные fallback (если OpenAI недоступен)
PIPER_PYTHON=C:\Python313\python.exe
PIPER_MODEL=C:\Users\...\backend\ru_RU-dmitri-medium.onnx
```

### 4. Запуск проекта

```powershell
# Активируйте venv если не активировано
.venv\Scripts\Activate.ps1

# Запустите backend
python backend/stream_server.py

# Или используйте готовый скрипт
.\run_reception_all.ps1
```

## Архитектура потока

```
Пользователь говорит
    ↓
WebRTC (браузер) → VAD (локально, webrtcvad)
    ↓
OpenAI Whisper API (STT) ← fallback: local whisper.cpp
    ↓
OpenAI GPT-4o-mini (LLM + function calling)
    → возвращает: {text, emotion, gesture}
    ↓
OpenAI TTS API (audio synthesis) ← fallback: Piper/Coqui
    ↓
Avatar Render (SadTalker, локально)
    ↓
WebRTC → Пользователь видит/слышит ответ
```

## Управление сервисами

В `.env` можно включать/выключать каждый OpenAI сервис:

```env
# Только STT через OpenAI, остальное локально
USE_OPENAI_STT=true
USE_OPENAI_LLM=false
USE_OPENAI_TTS=false

# Всё через OpenAI (максимальная интеграция)
USE_OPENAI_STT=true
USE_OPENAI_LLM=true
USE_OPENAI_TTS=true

# Полностью локально (без OpenAI)
USE_OPENAI_STT=false
USE_OPENAI_LLM=false
USE_OPENAI_TTS=false
```

## Преимущества OpenAI интеграции

✅ **Высокое качество** распознавания и генерации  
✅ **Многоязычность** (русский, казахский, английский)  
✅ **Emotion/Gesture detection** из коробки через function calling  
✅ **Быстрая разработка** - не нужно обучать модели  
✅ **Масштабируемость** - без требований к GPU  

## Стоимость (примерная)

- **Whisper API**: $0.006 / минута аудио
- **GPT-4o-mini**: $0.15 / 1M входных токенов, $0.60 / 1M выходных
- **TTS**: $15 / 1M символов

**Пример**: 1000 диалогов по 30 сек ≈ $5-10 в месяц

## Локальные Fallback

Если OpenAI недоступен, система автоматически переключится на:
- **STT**: whisper.cpp (локально)
- **LLM**: ваш OPENAI_MODEL в .env (может быть локальная модель)
- **TTS**: Piper или Coqui TTS (локально)

## Тестирование

```powershell
# Проверка OpenAI подключения
python -c "from openai import OpenAI; import os; from dotenv import load_dotenv; load_dotenv('backend/.env'); client = OpenAI(api_key=os.getenv('OPENAI_API_KEY')); print('OK:', client.models.list().data[0].id)"

# Запуск backend
python backend/stream_server.py

# Откройте браузер
start http://localhost:5500/kiosk.html
```

## Troubleshooting

### Ошибка: "OpenAI API key not set"
- Проверьте `backend/.env` → `OPENAI_API_KEY=sk-...`
- Убедитесь, что файл `.env` находится в папке `backend/`

### Ошибка: "Module 'openai' not found"
```powershell
pip install --upgrade openai
```

### Медленная работа
- Проверьте интернет соединение
- Включите локальные fallback сервисы
- Уменьшите `OPENAI_MAX_TOKENS` в `.env`

### Отключить OpenAI и использовать локально
В `.env` поставьте:
```env
USE_OPENAI_STT=false
USE_OPENAI_LLM=false
USE_OPENAI_TTS=false
```

## Дополнительные возможности OpenAI

Можно добавить позже:
- **Vision API** (GPT-4 Vision) для анализа видео с камеры
- **Embeddings API** для семантического поиска в базе знаний
- **Moderation API** для фильтрации токсичного контента
- **Fine-tuning** для специализированных моделей

## Поддержка

Вопросы? Проверьте:
- [AVATAR_QUICKSTART.md](AVATAR_QUICKSTART.md)
- [TEST_INSTRUCTIONS.md](TEST_INSTRUCTIONS.md)
- Логи в консоли: `python backend/stream_server.py`
