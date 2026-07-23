# PowerShell 一键启动脚本 (支持 UTF-8 编码)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "               NovaStory 一键启动脚本" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[0/2] 正在检查并清理已占用的旧进程与旧窗口 (端口 8087, 3000, 3001)..." -ForegroundColor Yellow
$ports = @(8087, 3000, 3001)
foreach ($port in $ports) {
    try {
        $pids = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($pidToKill in $pids) {
            if ($pidToKill -and $pidToKill -ne 0 -and $pidToKill -ne $PID) {
                Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*NovaStory*" -or $_.MainWindowTitle -like "*ComfyUI*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Host "[1/2] 正在拉起 NovaStory 后端 FastAPI (端口 8087)..." -ForegroundColor Green
$BackendDir = Join-Path $PSScriptRoot "backend"
Start-Process cmd -ArgumentList "/c", "chcp 65001 >nul && cd /d $BackendDir && .\.venv\Scripts\python.exe main.py"

Write-Host "[2/2] 正在拉起 NovaStory 前端 Vite (端口 3000)..." -ForegroundColor Green
$FrontendDir = Join-Path $PSScriptRoot "frontend"
Start-Process cmd -ArgumentList "/c", "chcp 65001 >nul && cd /d $FrontendDir && npm run dev"

Write-Host "`n所有服务启动命令已派发！" -ForegroundColor Yellow
Write-Host "  - 后端 API 服务:     http://127.0.0.1:8087/docs" -ForegroundColor Gray
Write-Host "  - 前端导演台界面:   http://localhost:3000" -ForegroundColor Gray
Write-Host "  - ComfyUI 生图引擎: (生图时自动开启，完成时自动关闭)" -ForegroundColor Gray
