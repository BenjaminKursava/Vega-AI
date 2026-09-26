@echo off
REM ============================================================
REM  Gava - start all needed services, each in its own window
REM  Just double-click this file (or run: start-jarvis.bat)
REM
REM  Windows opened:
REM    1) Ollama (LLM engine :11434)  - only if not already running
REM    2) Gava Server (:8000)         - API + web UI
REM  Browser opens automatically at http://127.0.0.1:8000
REM
REM  To STOP: close a window (or Ctrl+C inside it), or run stop-jarvis.bat
REM ============================================================

echo Starting Gava services...

REM --- Optional: Gemini cloud models. Get an AIza... key from
REM --- https://aistudio.google.com/apikey then remove "REM " below:
REM set GEMINI_API_KEY=AIza...your-key-here

set PYTHONUTF8=1

REM --- Stability pins (Aug 2026) --------------------------------------
REM The venv is built on the SYSTEM Python below - never on uv's managed
REM Python store, whose intermittent Windows breakage caused the random
REM "No Python at ..." launcher failures. downloads=never makes uv
REM incapable of silently switching back. --no-sync (on the serve line)
REM stops uv run from "correcting" the environment at startup - its
REM implicit sync uninstalls the maturin-built openjarvis_rust package.
set UV_PYTHON=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
set UV_PYTHON_DOWNLOADS=never

REM 0) Free port 8000 (stops any stale Gava server)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000" ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1

REM 1) Ollama engine on :11434 - start only if not already running
netstat -ano | findstr ":11434" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo   Ollama already running on :11434 - OK
) else (
    start "Ollama (LLM engine :11434)" cmd /k "ollama serve"
)

REM 2) Gava API server + web UI on :8000
start "Gava Server (:8000)" cmd /k "cd /d %~dp0 && uv run --no-sync jarvis serve"

echo.
echo Windows opened. Waiting for the server to warm up...
timeout /t 12 /nobreak >nul
start "" http://127.0.0.1:8000
echo.
echo If the page shows an error, wait a few seconds and refresh -
echo the first start takes ~20 seconds.
echo.
pause
