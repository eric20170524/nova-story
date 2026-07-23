@echo off
chcp 936 >nul
title NovaStory 一键停止脚本
echo ========================================================
echo               NovaStory 一键停止脚本
echo ========================================================
echo.
echo 正在停止占用端口 8188, 8087, 3000 的服务进程...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8188,8087,3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id `$_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":8188 " /C:":8087 " /C:":3000 " ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo.
echo 所有 NovaStory 相关服务进程已清理完毕！
pause
