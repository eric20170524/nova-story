@echo off
chcp 936 >nul
title NovaStory 一键全套服务启动脚本
echo ========================================================
echo               NovaStory 一键全套启动脚本
echo ========================================================
echo.

echo [0/3] 正在检查并清理已占用的旧进程 (端口 8188, 8087, 3000)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8188,8087,3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id `$_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":8188 " /C:":8087 " /C:":3000 " ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [1/3] 正在拉起 ComfyUI 生图服务 (端口 8188)...
start "ComfyUI Server (8188)" cmd /k "chcp 65001 >nul && cd /d D:\ComfyUI && .\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188 --lowvram"

echo [2/3] 正在拉起 NovaStory 后端 FastAPI 服务 (端口 8087)...
start "NovaStory Backend (8087)" cmd /k "chcp 65001 >nul && cd /d %~dp0backend && .\.venv\Scripts\python.exe main.py"

echo [3/3] 正在拉起 NovaStory 前端 Vite 界面 (端口 3000)...
start "NovaStory Frontend (3000)" cmd /k "chcp 65001 >nul && cd /d %~dp0frontend && npm run dev"

echo.
echo ========================================================
echo  所有服务启动命令已派发！
echo  - ComfyUI 生图引擎: http://127.0.0.1:8188
echo  - 后端 API 服务:     http://127.0.0.1:8087/docs
echo  - 前端导演台界面:   http://localhost:3000
echo ========================================================
pause
