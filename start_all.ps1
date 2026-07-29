[CmdletBinding()]
param(
    [switch]$ComfyUIOnly,
    [switch]$SkipComfyUI
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RootDir = $PSScriptRoot
$BackendDir = Join-Path $RootDir 'backend'
$SettingsFile = Join-Path $BackendDir 'system_settings.json'

function Stop-PortListeners {
    param([int[]]$Ports)

    foreach ($port in $Ports) {
        $processIds = @(
            Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique
        )

        foreach ($processId in $processIds) {
            if ($processId -and $processId -ne 0 -and $processId -ne $PID) {
                Write-Host "  Stopping PID $processId on port $port..." -ForegroundColor DarkGray
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Assert-Command {
    param(
        [string]$Name,
        [string]$InstallHint
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found. $InstallHint"
    }
}

function Install-DependenciesIfNeeded {
    param(
        [string]$Directory,
        [string]$ExpectedExecutable,
        [string]$Label
    )

    $packageFile = Join-Path $Directory 'package.json'
    if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) {
        throw "$Label package.json was not found at: $packageFile"
    }

    $executable = Join-Path $Directory $ExpectedExecutable
    if (Test-Path -LiteralPath $executable -PathType Leaf) {
        return
    }

    Write-Host "Installing $Label dependencies..." -ForegroundColor Yellow
    Push-Location $Directory
    try {
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed for $Label (exit code $LASTEXITCODE)."
        }
    }
    finally {
        Pop-Location
    }
}

function Start-NpmService {
    param(
        [string]$Title,
        [string]$Directory,
        [string]$Script
    )

    $command = "chcp 65001 >nul && title $Title && cd /d `"$Directory`" && npm.cmd run $Script"
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/k', $command) -WorkingDirectory $Directory | Out-Null
}

function Get-ComfyUIPath {
    if ($env:NOVASTORY_COMFYUI_DIR) {
        return $env:NOVASTORY_COMFYUI_DIR
    }

    if (Test-Path -LiteralPath $SettingsFile -PathType Leaf) {
        try {
            $settings = Get-Content -LiteralPath $SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($settings.comfyui.install_path) {
                return [string]$settings.comfyui.install_path
            }
        }
        catch {
            Write-Warning "Could not read ComfyUI path from $SettingsFile. Using the default path."
        }
    }

    return 'D:\ComfyUI'
}

function Find-ComfyPython {
    param([string]$ComfyDir)

    $parentDir = Split-Path -Parent $ComfyDir
    $candidates = @(
        (Join-Path $ComfyDir 'venv\Scripts\python.exe'),
        (Join-Path $ComfyDir '.venv\Scripts\python.exe'),
        (Join-Path $ComfyDir 'python_embeded\python.exe'),
        (Join-Path $parentDir 'python_embeded\python.exe')
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    $globalPython = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($globalPython) {
        return $globalPython.Source
    }

    return $null
}

function Start-ComfyUI {
    $comfyDir = Get-ComfyUIPath
    $mainFile = Join-Path $comfyDir 'main.py'

    if (-not (Test-Path -LiteralPath $mainFile -PathType Leaf)) {
        Write-Warning "ComfyUI was not found at '$comfyDir'. Configure comfyui.install_path in backend\system_settings.json or set NOVASTORY_COMFYUI_DIR."
        return $false
    }

    $pythonExe = Find-ComfyPython -ComfyDir $comfyDir
    if (-not $pythonExe) {
        Write-Warning "Python was not found for ComfyUI at '$comfyDir'."
        return $false
    }

    $ollamaCandidates = @(
        'D:\Program Files\Ollama\ollama.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe')
    )
    $ollamaCommand = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($ollamaCommand) {
        $ollamaCandidates += $ollamaCommand.Source
    }
    $ollamaExe = $ollamaCandidates |
        Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
        Select-Object -First 1
    if ($ollamaExe) {
        Write-Host '  Releasing local LLM VRAM before starting ComfyUI...' -ForegroundColor DarkGray
        # Ollama writes terminal control sequences to stderr even when the
        # command succeeds. Windows PowerShell turns that stderr output into a
        # terminating NativeCommandError because this script uses
        # $ErrorActionPreference = 'Stop'. Run it through cmd so both native
        # streams are suppressed before PowerShell can reinterpret them.
        $ollamaStopCommand = "`"$ollamaExe`" stop novastory-qwen3:8b >nul 2>&1"
        & $env:ComSpec /d /c $ollamaStopCommand
    }

    # Pinned model weights can consume more than 6 GB of system RAM on this
    # 16 GB Windows machine and make Pony XL fail while initializing its text
    # encoder. Avoid pinned copies and cached node outputs in local mode.
    $command = "chcp 65001 >nul && title ComfyUI Server (8188) && cd /d `"$comfyDir`" && `"$pythonExe`" main.py --listen 127.0.0.1 --port 8188 --lowvram --disable-pinned-memory --cache-none"
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/k', $command) -WorkingDirectory $comfyDir | Out-Null
    return $true
}

try {
    if ($ComfyUIOnly -and $SkipComfyUI) {
        throw 'ComfyUIOnly and SkipComfyUI cannot be used together.'
    }

    Write-Host '========================================================' -ForegroundColor Cyan
    Write-Host '                 NovaStory Launcher' -ForegroundColor Cyan
    Write-Host '========================================================' -ForegroundColor Cyan

    if ($ComfyUIOnly) {
        Write-Host '[1/2] Releasing port 8188...' -ForegroundColor Yellow
        Stop-PortListeners -Ports @(8188)
        Start-Sleep -Seconds 1

        Write-Host '[2/2] Starting ComfyUI...' -ForegroundColor Green
        if (-not (Start-ComfyUI)) {
            exit 1
        }

        Write-Host 'ComfyUI start command dispatched: http://127.0.0.1:8188' -ForegroundColor Cyan
        exit 0
    }

    Assert-Command -Name 'node.exe' -InstallHint 'Install Node.js 18 or newer and reopen this launcher.'
    Assert-Command -Name 'npm.cmd' -InstallHint 'Install Node.js 18 or newer and reopen this launcher.'

    Write-Host '[1/4] Checking Node.js dependencies...' -ForegroundColor Yellow
    Install-DependenciesIfNeeded -Directory $BackendDir -ExpectedExecutable 'node_modules\.bin\tsx.cmd' -Label 'backend'
    Install-DependenciesIfNeeded -Directory $RootDir -ExpectedExecutable 'node_modules\.bin\vite.cmd' -Label 'frontend'

    $ports = @(3000)
    if (-not $SkipComfyUI) {
        $ports += 8188
    }

    Write-Host "[2/4] Releasing ports $($ports -join ', ')..." -ForegroundColor Yellow
    Stop-PortListeners -Ports $ports
    Start-Sleep -Seconds 1

    Write-Host '[3/4] Starting Fastify backend and Vite frontend...' -ForegroundColor Green
    Start-NpmService -Title 'NovaStory Frontend (3000)' -Directory $RootDir -Script 'dev'

    Write-Host '[4/4] Starting optional ComfyUI service...' -ForegroundColor Green
    $comfyStarted = $false
    if (-not $SkipComfyUI) {
        $comfyStarted = Start-ComfyUI
    }

    Write-Host ''
    Write-Host 'Start commands dispatched successfully.' -ForegroundColor Cyan
    Write-Host '  Web App: http://localhost:3000/novastory/' -ForegroundColor Green
    if ($SkipComfyUI) {
        Write-Host '  ComfyUI:  skipped by -SkipComfyUI' -ForegroundColor DarkGray
    }
    elseif ($comfyStarted) {
        Write-Host '  ComfyUI:  http://127.0.0.1:8188' -ForegroundColor Gray
    }
    else {
        Write-Host '  ComfyUI:  not started (optional)' -ForegroundColor DarkGray
    }

    exit 0
}
catch {
    Write-Host ''
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
