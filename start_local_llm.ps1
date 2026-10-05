[CmdletBinding()]
param(
    [switch]$NoWarmup
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'local-llm\runtime.ps1')

$LogDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$PidFile = Join-Path $LogDir 'llama-server.pid'
$StdoutLog = Join-Path $LogDir 'llama-server.stdout.log'
$StderrLog = Join-Path $LogDir 'llama-server.stderr.log'

$serverPath = Get-LlamaServerPath
if (-not $serverPath) {
    throw 'llama-server.exe was not found. Run setup_local_llm.ps1 first.'
}
if (-not (Test-Path -LiteralPath $script:ModelFile -PathType Leaf)) {
    throw "Model was not found at '$($script:ModelFile)'. Run setup_local_llm.ps1 first."
}
if (-not (Test-Path -LiteralPath $script:ChatTemplateKwargs -PathType Leaf)) {
    throw "Chat template kwargs were not found at '$($script:ChatTemplateKwargs)'."
}

Stop-ComfyUiForLlm

if (Test-LocalLlmApi) {
    Write-Host "llama.cpp already serving $(Get-LocalLlmBaseUrl)/v1 ($($script:ModelAlias))" -ForegroundColor Green
}
else {
    Stop-LocalLlmServer
    Start-Sleep -Milliseconds 400

    $kwargs = (Get-Content -LiteralPath $script:ChatTemplateKwargs -Raw -Encoding UTF8).Trim()
    # Start-Process re-quotes ArgumentList on Windows and strips JSON quotes.
    $env:LLAMA_ARG_CHAT_TEMPLATE_KWARGS = $kwargs
    $serverDir = Split-Path -Parent $serverPath
    $cudaToolkitBin = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.4\bin'
    if (Test-Path -LiteralPath $cudaToolkitBin) {
        $env:PATH = "$serverDir;$cudaToolkitBin;$env:PATH"
    }
    else {
        $env:PATH = "$serverDir;$env:PATH"
    }
    $arguments = @(
        '-m', $script:ModelFile
        '--alias', $script:ModelAlias
        '--host', $script:LlmHost
        '--port', "$($script:LlmPort)"
        '-c', "$($script:CtxSize)"
        '-ngl', '99'
        '-np', '1'
        '--flash-attn', 'on'
        '--cache-type-k', 'q8_0'
        '--cache-type-v', 'q8_0'
        '--jinja'
        '--reasoning', 'off'
        '--temp', '0.85'
        '--top-p', '0.92'
        '--top-k', '40'
        '--min-p', '0.05'
        '--repeat-penalty', '1.08'
        '--no-webui'
        '--log-file', $StderrLog
    )

    Write-Host "Starting llama-server ($($script:ModelAlias), ctx $($script:CtxSize), GPU layers 99)..." -ForegroundColor Yellow
    $quotedArgs = (
        $arguments | ForEach-Object {
            if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
        }
    ) -join ' '
    $cmdLine = "`"$serverPath`" $quotedArgs"
    # Win32_Process.Create starts outside the parent job, so the server stays up
    # after this launcher (or an agent shell job) exits.
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $cmdLine
        CurrentDirectory = $serverDir
    }
    if (-not $created -or [int]$created.ReturnValue -ne 0 -or -not $created.ProcessId) {
        throw "Failed to create llama-server process (WMI return $($created.ReturnValue))."
    }
    Set-Content -LiteralPath $PidFile -Value $created.ProcessId -Encoding ASCII

    $ready = $false
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        Start-Sleep -Seconds 1
        $alive = Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue
        if (-not $alive) {
            throw "llama-server exited early. Check '$StderrLog'."
        }
        if (Test-LocalLlmApi) {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        throw "llama.cpp did not become ready. Check '$StderrLog'."
    }
}

if (-not $NoWarmup) {
    Write-Host "Warming $($script:ModelAlias)..." -ForegroundColor Yellow
    $body = @{
        model = $script:ModelAlias
        messages = @(@{ role = 'user'; content = '只回复：就绪' })
        max_tokens = 8
        chat_template_kwargs = @{ enable_thinking = $false }
        temperature = 0.1
    } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Post -Uri "$(Get-LocalLlmBaseUrl)/v1/chat/completions" `
        -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 180 | Out-Null
}

Write-Host "Local LLM ready: $(Get-LocalLlmBaseUrl)/v1 ($($script:ModelAlias))" -ForegroundColor Green
try {
    Invoke-RestMethod -Uri "$(Get-LocalLlmBaseUrl)/v1/models" -TimeoutSec 5 | ConvertTo-Json -Depth 5
}
catch {
    Write-Host 'Models endpoint probe skipped.' -ForegroundColor DarkGray
}
