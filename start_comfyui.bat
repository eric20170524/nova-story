@echo off
setlocal
chcp 65001 >nul
title ComfyUI Launcher

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_all.ps1" -ComfyUIOnly
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo ComfyUI failed to start. See the error above.
    pause
)

exit /b %EXIT_CODE%
