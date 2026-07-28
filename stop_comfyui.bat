@echo off
setlocal
chcp 65001 >nul
title Stop ComfyUI

echo Stopping ComfyUI and releasing image-generation VRAM...
powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
echo ComfyUI stopped.
