@echo off
chcp 936 >nul
echo 正在停止 ComfyUI 生图服务并释放 GPU 显存...
powershell -Command "Get-NetTCPConnection -LocalPort 8188 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
powershell -Command "ollama stop qwen3.5:9b"
echo ComfyUI 已关闭，GPU 显存已释放！
pause
