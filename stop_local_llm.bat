@echo off
setlocal
chcp 65001 >nul
title Stop NovaStory Local LLM

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop_local_llm.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo Failed to release local LLM memory.
    pause
)

exit /b %EXIT_CODE%
