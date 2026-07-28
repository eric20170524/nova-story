@echo off
setlocal
chcp 65001 >nul
title NovaStory Local LLM

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_local_llm.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo Local LLM failed to start. See the error above.
    pause
)

exit /b %EXIT_CODE%
