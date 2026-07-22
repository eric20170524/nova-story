# PowerShell 一键启动脚本 (支持 UTF-8 编码)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "               NovaStory 一键启动脚本" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/3] 正在拉起 ComfyUI 生图服务 (端口 8188)..." -ForegroundColor Green
Start-Process cmd -ArgumentList "/k", "chcp 65001 >nul && cd /d D:\ComfyUI && .\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188 --lowvram"

Write-Host "[2/3] 正在拉起 NovaStory 后端 FastAPI (端口 8087)..." -ForegroundColor Green
$BackendDir = Join-Path $PSScriptRoot "backend"
Start-Process cmd -ArgumentList "/k", "chcp 65001 >nul && cd /d $BackendDir && ..\.venv\Scripts\python.exe main.py"

Write-Host "[3/3] 正在拉起 NovaStory 前端 Vite (端口 3000)..." -ForegroundColor Green
$FrontendDir = Join-Path $PSScriptRoot "frontend"
Start-Process cmd -ArgumentList "/k", "chcp 65001 >nul && cd /d $FrontendDir && npm run dev"

Write-Host "`n所有服务启动命令已派发！" -ForegroundColor Yellow
Write-Host "  - ComfyUI 生图引擎: http://127.0.0.1:8188" -ForegroundColor Gray
Write-Host "  - 后端 API 服务:     http://127.0.0.1:8087/docs" -ForegroundColor Gray
Write-Host "  - 前端导演台界面:   http://localhost:3000" -ForegroundColor Gray
