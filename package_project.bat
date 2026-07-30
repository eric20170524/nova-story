@echo off
chcp 65001 >nul
title Package NovaStory Source Code for AI Studio
echo ========================================================
echo   NovaStory 源码一键打包脚本 (AI Studio / Web 同步)
echo ========================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package_project.ps1"

echo.
echo ========================================================
echo 打包完成！可以双击或上传 nova-story-source.zip
echo ========================================================
pause
