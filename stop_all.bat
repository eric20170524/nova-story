@echo off
setlocal
chcp 65001 >nul
title Stop NovaStory

echo Stopping NovaStory, ComfyUI, and the local LLM server...
powershell.exe -NoProfile -Command "$ports = @(8188,3000,11434); Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
echo All NovaStory services stopped.
