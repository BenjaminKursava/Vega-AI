@echo off
REM ============================================================
REM  Gava - stop the server
REM  (Ollama is left running: it is shared by other apps and
REM   uses no resources while idle.)
REM ============================================================

echo Stopping Gava server (port 8000)...
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p
    set FOUND=1
)
if "%FOUND%"=="0" echo No Gava server was running.
echo Done.
pause
