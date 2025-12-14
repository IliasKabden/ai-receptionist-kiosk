AI Receptionist — 3D Real-time Avatar + Streaming Pipeline + Multi-language

## 🎭 NEW: Real-time 3D Avatar with Emotions & Gestures

✅ **Client-side 3D rendering** (zero backend latency)  
✅ **Real-time lip-sync** via WebAudio analysis  
✅ **Automatic emotions** (happy, sad, thinking, surprised, neutral)  
✅ **Gestures** (wave, point) triggered by LLM responses  
✅ **VRM model support** — load custom 3D avatars  
✅ **Production-grade** — same tech as Soul Machines, UneeQ  

**👉 See [AVATAR_QUICKSTART.md](AVATAR_QUICKSTART.md) for avatar setup!**

---<img width="1901" height="903" alt="11d3bd14-56a5-4f43-9744-c3be8b0a7bb1" src="https://github.com/user-attachments/assets/e03cdfd0-c884-456a-875c-fc60a44e9ba8" />


В этой версии:
- Выбор языка в админке (kk / ru / en) напрямую управляет:
  - языком распознавания (Whisper STT)
  - языком ответов ассистента (свой system prompt под каждый язык)
То есть: выбрал "Русский" → говоришь по‑русски → он отвечает по‑русски.

1. Установка

Распакуй архив, напр. в:
C:\Users\...\Desktop\NU\ai_receptionist_sadtalker_langfix

В PowerShell в этой папке:

  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  .\run_kiosk_desktop.ps1 -Setup

Потом скопируй backend\.env.example -> backend\.env и заполни:

  OPENAI_API_KEY=sk-...твой...
  OPENAI_MODEL=gpt-4.1-mini
  PIPER_PYTHON=C:\Python313\python.exe
  PIPER_MODEL=ru_RU-dmitri-medium

2. Голос Piper

В папке backend один раз:

  cd backend
  C:\Python313\python.exe -m pip install piper-tts
  C:\Python313\python.exe -m piper.download_voices ru_RU-dmitri-medium
  C:\Python313\python.exe -m piper --model ru_RU-dmitri-medium --output-file test.wav -- "Проверка голоса."

3. Язык ассистента

Admin UI: http://localhost:5500/admin.html

- Выбираешь "Русский"
- Жмёшь "Сохранить"

Ассистент:
- слушает русскую речь
- отвечает по‑русски
Никаких дополнительных перезапусков не нужно.

4. Запуск киоска

Из корня проекта:

  .\run_kiosk_desktop.ps1
