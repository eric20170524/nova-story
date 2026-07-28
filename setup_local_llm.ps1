[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RootDir = $PSScriptRoot
$OllamaDir = 'D:\Program Files\Ollama'
$OllamaExe = Join-Path $OllamaDir 'ollama.exe'
$ModelDir = 'D:\ProgramData\Ollama\models'
$ModelName = 'novastory-qwen3:8b'
$BaseModel = 'huihui_ai/qwen3-abliterated:8b-v2-q4_K_M'
$Modelfile = Join-Path $RootDir 'local-llm\Modelfile'
$LogDir = Join-Path $RootDir 'logs'

if (-not (Test-Path -LiteralPath $OllamaExe -PathType Leaf)) {
    $command = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($command) {
        $OllamaExe = $command.Source
    }
    else {
        throw "Ollama was not found at '$OllamaExe' or on PATH."
    }
}

if (-not (Test-Path -LiteralPath $Modelfile -PathType Leaf)) {
    throw "Modelfile was not found at '$Modelfile'."
}

New-Item -ItemType Directory -Path $ModelDir -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

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

if (-not (Test-OllamaApi)) {
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

Write-Host "Pulling $BaseModel into $ModelDir..." -ForegroundColor Yellow
& $OllamaExe pull $BaseModel
if ($LASTEXITCODE -ne 0) {
    throw "Failed to pull $BaseModel."
}

Write-Host "Creating the pinned NovaStory model profile $ModelName..." -ForegroundColor Yellow
& $OllamaExe create $ModelName -f $Modelfile
if ($LASTEXITCODE -ne 0) {
    throw "Failed to create $ModelName."
}

Write-Host 'Local language model setup completed.' -ForegroundColor Green
& $OllamaExe list
