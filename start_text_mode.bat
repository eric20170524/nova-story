@echo off
setlocal
chcp 65001 >nul
title NovaStory Text Mode

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_local_llm.ps1"
if errorlevel 1 (
    echo.
    echo Local LLM failed to start.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_all.ps1" -SkipComfyUI
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo NovaStory text mode failed to start.
    pause
)

exit /b %EXIT_CODE%
