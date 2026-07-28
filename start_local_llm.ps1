[CmdletBinding()]
param(
    [switch]$NoWarmup
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RootDir = $PSScriptRoot
$OllamaExe = 'D:\Program Files\Ollama\ollama.exe'
$ModelDir = 'D:\ProgramData\Ollama\models'
$ModelName = 'novastory-qwen3:8b'
$LogDir = Join-Path $RootDir 'logs'

if (-not (Test-Path -LiteralPath $OllamaExe -PathType Leaf)) {
    $command = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($command) {
        $OllamaExe = $command.Source
    }
    else {
        throw 'Ollama was not found. Run setup_local_llm.ps1 first.'
    }
}

$env:OLLAMA_MODELS = $ModelDir
$env:OLLAMA_FLASH_ATTENTION = '1'
$env:OLLAMA_KV_CACHE_TYPE = 'q8_0'
$env:OLLAMA_CONTEXT_LENGTH = '8192'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_KEEP_ALIVE = '2m'
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_NO_CLOUD = '1'

function Test-OllamaApi {
    try {
        Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Test-ComfyUIApi {
    try {
        Invoke-RestMethod -Uri 'http://127.0.0.1:8188/system_stats' -TimeoutSec 2 | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

$comfyWasRunning = Test-ComfyUIApi
$comfyPids = @(
    Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
)
if ($comfyWasRunning -and $comfyPids.Count -eq 0) {
    $comfyPids = @(
        netstat.exe -ano -p TCP |
            ForEach-Object {
                if ($_ -match '^\s*TCP\s+\S+:8188\s+\S+\s+LISTENING\s+(\d+)\s*$') {
                    [int]$matches[1]
                }
            } |
            Select-Object -Unique
    )
}

if ($comfyWasRunning -and $comfyPids.Count -eq 0) {
    throw 'ComfyUI is running on port 8188, but its process could not be identified. Stop ComfyUI before starting the local LLM.'
}

foreach ($processId in $comfyPids) {
    if ($processId -and $processId -ne 0 -and $processId -ne $PID) {
        Write-Host "Stopping ComfyUI PID $processId to release VRAM..." -ForegroundColor Yellow
        Stop-Process -Id $processId -Force -ErrorAction Stop
    }
}

if ($comfyWasRunning) {
    for ($attempt = 0; $attempt -lt 10 -and (Test-ComfyUIApi); $attempt++) {
        Start-Sleep -Seconds 1
    }
    if (Test-ComfyUIApi) {
        throw 'ComfyUI did not stop cleanly; refusing to load a second GPU model.'
    }
}

if (-not (Test-OllamaApi)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    $stdoutLog = Join-Path $LogDir 'ollama-serve.stdout.log'
    $stderrLog = Join-Path $LogDir 'ollama-serve.stderr.log'
    Start-Process -FilePath $OllamaExe -ArgumentList @('serve') -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog | Out-Null

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        if (Test-OllamaApi) {
            $ready = $true
            break
        }
    }

    if (-not $ready) {
        throw "Ollama did not become ready. Check '$stderrLog'."
    }
}

$installedModelText = (& $OllamaExe list) -join [Environment]::NewLine
if ($installedModelText -notmatch [regex]::Escape($ModelName)) {
    throw "Model '$ModelName' is not installed. Run setup_local_llm.ps1 first."
}

if (-not $NoWarmup) {
    Write-Host "Loading $ModelName into GPU memory..." -ForegroundColor Yellow
    $body = @{
        model = $ModelName
        messages = @(@{ role = 'user'; content = '只回复：就绪' })
        stream = $false
        think = $false
        keep_alive = '2m'
        options = @{ num_predict = 8 }
    } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:11434/api/chat' `
        -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 120 | Out-Null
}

Write-Host "Local LLM ready: http://127.0.0.1:11434/v1 ($ModelName)" -ForegroundColor Green
& $OllamaExe ps
