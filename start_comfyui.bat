@echo off
chcp 936 >nul
echo 正在拉起 ComfyUI 生图服务 (端口 8188)...
cd /d D:\ComfyUI
.\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188 --lowvram
pause
