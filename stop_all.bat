@echo off
chcp 936 >nul
title NovaStory 一键停止脚本
echo ========================================================
echo               NovaStory 一键停止脚本
echo ========================================================
echo.
echo 正在停止占用端口 8188, 8087, 3000 的服务进程...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r ":8188[ ] :8087[ ] :3000[ ]"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo.
echo 所有 NovaStory 相关服务进程已清理完毕！
pause
