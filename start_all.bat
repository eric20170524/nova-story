@echo off
setlocal
chcp 65001 >nul
title NovaStory Launcher

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_all.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo NovaStory failed to start. See the error above.
    pause
)

exit /b %EXIT_CODE%
