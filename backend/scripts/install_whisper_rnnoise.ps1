# Helper script: instructions to install whisper.cpp (ggml) and RNNoise on Windows (WSL recommended)
# This script prints step-by-step commands and does not attempt to compile on pure Windows.

Write-Host "=== whisper.cpp + RNNoise install helper ==="
Write-Host "Recommended: use WSL (Ubuntu) for building whisper.cpp and RNNoise."
Write-Host "If you prefer native Windows builds, follow project docs or use prebuilt binaries when available."

Write-Host "\nWSL (Ubuntu) recommended steps:"
Write-Host "1) Open WSL terminal (Ubuntu) and install dependencies:"
Write-Host "   sudo apt update && sudo apt install -y build-essential cmake git wget libsndfile1-dev"
Write-Host "2) Build whisper.cpp (ggml)"
Write-Host "   git clone https://github.com/ggerganov/whisper.cpp.git"
Write-Host "   cd whisper.cpp && make && cd .."
Write-Host "   The built binary will be at whisper.cpp/main"

Write-Host "3) Download a ggml model (e.g., small or base). Example (in WSL):"
Write-Host "   mkdir -p ~/models && cd ~/models"
Write-Host "   wget -c https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

Write-Host "4) RNNoise (build native demo):"
Write-Host "   git clone https://github.com/xiph/rnnoise.git"
Write-Host "   cd rnnoise && ./autogen.sh && ./configure && make"
Write-Host "   The demo binary will be at rnnoise/examples/rnnoise_demo"

Write-Host "5) After building, set environment variables in Windows or WSL env for your server:
   WHISPER_CPP_BIN -> path/to/whisper.cpp/main (WSL path or Windows path)
   WHISPER_MODEL -> path/to/ggml-*.bin
   RNNOISE_BIN -> path/to/rnnoise_demo"

Write-Host "Windows notes:"
Write-Host "- You can run the server inside WSL and point the backend env vars to WSL paths, or copy binaries to Windows and set WHISPER_CPP_BIN accordingly."
Write-Host "- If you need, I can prepare a small PowerShell wrapper to call the WSL binary via 'wsl /path/to/whisper.cpp/main' transparently."

Write-Host "Done. If you want, run this script with -ExecutionPolicy Bypass, and then tell me which environment you prefer (WSL or native Windows)."
