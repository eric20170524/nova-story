@echo off
chcp 936 >nul
echo 正在拉起 ComfyUI 生图服务 (端口 8188)...
REM Parse from backend\system_settings.json or use fallback
set "COMFYUI_DIR=D:\ComfyUI"
if exist "%~dp0backend\system_settings.json" (
    for /f "tokens=4 delims=:, " %%a in ('findstr /I "install_path" "%~dp0backend\system_settings.json"') do (
        set "COMFYUI_DIR=%%~a"
    )
)
set COMFYUI_DIR=%COMFYUI_DIR:"=%
if not exist "%COMFYUI_DIR%" set "COMFYUI_DIR=D:\ComfyUI"
cd /d "%COMFYUI_DIR%"
.\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188 --lowvram
pause
