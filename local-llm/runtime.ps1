# Shared paths and helpers for NovaStory llama.cpp local LLM.

$script:LlamaDir = 'D:\llama.cpp'
$script:LlamaServer = Join-Path $script:LlamaDir 'llama-server.exe'
$script:ModelDir = 'D:\ProgramData\NovaStory\models'
$script:ModelFileName = 'Huihui-Qwen3.5-9B-abliterated.Q4_K_M.gguf'
$script:ModelFile = Join-Path $script:ModelDir $script:ModelFileName
$script:ModelAlias = 'novastory-qwen3.5:9b'
$script:HfRepo = 'mradermacher/Huihui-Qwen3.5-9B-abliterated-GGUF'
$script:LlamaRelease = 'b11390'
$script:LlmHost = '127.0.0.1'
$script:LlmPort = 11434
$script:CtxSize = 16384
$script:ChatTemplateKwargs = Join-Path $PSScriptRoot 'chat-template-kwargs.json'
$script:PidFile = Join-Path $PSScriptRoot '..\logs\llama-server.pid'

function Get-LlamaServerPath {
    if (Test-Path -LiteralPath $script:LlamaServer -PathType Leaf) {
        return $script:LlamaServer
    }
    $found = Get-ChildItem -LiteralPath $script:LlamaDir -Filter 'llama-server.exe' -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) {
        return $found.FullName
    }
    $command = Get-Command llama-server.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    return $null
}

function Get-LocalLlmBaseUrl {
    return "http://$($script:LlmHost):$($script:LlmPort)"
}

function Test-LocalLlmApi {
    try {
        $models = Invoke-RestMethod -Uri "$(Get-LocalLlmBaseUrl)/v1/models" -TimeoutSec 2
        $ids = @()
        if ($models.data) {
            $ids = @($models.data | ForEach-Object { [string]$_.id })
        }
        return $ids -contains $script:ModelAlias
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

function Get-ListenersOnPort {
    param([int]$Port)

    $pids = @(
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    if ($pids.Count -eq 0) {
        $pids = @(
            netstat.exe -ano -p TCP |
                ForEach-Object {
                    if ($_ -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
                        [int]$matches[1]
                    }
                } |
                Select-Object -Unique
        )
    }
    return @($pids | Where-Object { $_ -and $_ -ne 0 })
}

function Stop-PortListeners {
    param(
        [int]$Port,
        [string]$Reason = 'release the port'
    )

    $processIds = Get-ListenersOnPort -Port $Port
    foreach ($processId in $processIds) {
        if ($processId -eq $PID) { continue }
        Write-Host "Stopping PID $processId on port $Port to $Reason..." -ForegroundColor Yellow
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ComfyUiForLlm {
    $comfyWasRunning = Test-ComfyUIApi
    $comfyPids = Get-ListenersOnPort -Port 8188
    if ($comfyWasRunning -and $comfyPids.Count -eq 0) {
        throw 'ComfyUI is running on port 8188, but its process could not be identified. Stop ComfyUI before starting the local LLM.'
    }
    foreach ($processId in $comfyPids) {
        Write-Host "Stopping ComfyUI PID $processId to release VRAM..." -ForegroundColor Yellow
        Stop-Process -Id $processId -Force -ErrorAction Stop
    }
    if ($comfyWasRunning) {
        for ($attempt = 0; $attempt -lt 10 -and (Test-ComfyUIApi); $attempt++) {
            Start-Sleep -Seconds 1
        }
        if (Test-ComfyUIApi) {
            throw 'ComfyUI did not stop cleanly; refusing to load a second GPU model.'
        }
    }
}

function Stop-LocalLlmServer {
    $pidPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\logs\llama-server.pid'))
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        $savedPid = 0
        [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$savedPid)
        if ($savedPid -gt 0) {
            $proc = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -match 'llama') {
                Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
    Get-Process -Name @('ollama', 'ollama app') -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Stop-PortListeners -Port $script:LlmPort -Reason 'stop the local llama.cpp server'
    Start-Sleep -Milliseconds 500
}
