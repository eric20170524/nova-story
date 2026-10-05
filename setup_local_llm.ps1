[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'local-llm\runtime.ps1')

$TmpDir = 'D:\ProgramData\NovaStory\tmp'
$LogDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Path $script:LlamaDir, $script:ModelDir, $TmpDir, $LogDir -Force | Out-Null

function Get-FileSizeBytes {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
    return [int64](Get-Item -LiteralPath $Path).Length
}

function Invoke-Download {
    param(
        [string]$Url,
        [string]$OutFile
    )
    Write-Host "Downloading $Url" -ForegroundColor Yellow
    & curl.exe -L --retry 5 --retry-delay 2 --fail -o $OutFile $Url
    if ($LASTEXITCODE -ne 0) {
        throw "Download failed ($LASTEXITCODE): $Url"
    }
}

$serverPath = Get-LlamaServerPath
if (-not $serverPath) {
    $rel = $script:LlamaRelease
    $base = "https://github.com/ggml-org/llama.cpp/releases/download/$rel"
    $zip = Join-Path $TmpDir "llama-$rel-bin-win-cuda-12.4-x64.zip"
    $cudart = Join-Path $TmpDir "cudart-llama-bin-win-cuda-12.4-x64.zip"
    if ((Get-FileSizeBytes $zip) -lt 10MB) {
        Invoke-Download -Url "$base/llama-$rel-bin-win-cuda-12.4-x64.zip" -OutFile $zip
    }
    Write-Host "Extracting llama.cpp $rel into $($script:LlamaDir)..." -ForegroundColor Yellow
    Expand-Archive -LiteralPath $zip -DestinationPath $script:LlamaDir -Force
    $cudaToolkitBin = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.4\bin'
    $copiedFromToolkit = $false
    if (Test-Path -LiteralPath $cudaToolkitBin) {
        foreach ($dll in @('cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll')) {
            $src = Join-Path $cudaToolkitBin $dll
            if (Test-Path -LiteralPath $src -PathType Leaf) {
                Copy-Item -LiteralPath $src -Destination (Join-Path $script:LlamaDir $dll) -Force
                $copiedFromToolkit = $true
            }
        }
    }
    if (-not $copiedFromToolkit) {
        if ((Get-FileSizeBytes $cudart) -lt 1MB) {
            Invoke-Download -Url "$base/cudart-llama-bin-win-cuda-12.4-x64.zip" -OutFile $cudart
        }
        Expand-Archive -LiteralPath $cudart -DestinationPath $script:LlamaDir -Force
    }
    $serverPath = Get-LlamaServerPath
}

if (-not $serverPath) {
    throw "llama-server.exe was not found under '$($script:LlamaDir)'."
}

$script:LlamaServer = $serverPath
Write-Host "llama-server: $serverPath" -ForegroundColor Green

if (-not (Test-Path -LiteralPath $script:ModelFile -PathType Leaf) -or ((Get-FileSizeBytes $script:ModelFile) -lt 4GB)) {
    $urls = @(
        "https://huggingface.co/$($script:HfRepo)/resolve/main/$($script:ModelFileName)",
        "https://hf-mirror.com/$($script:HfRepo)/resolve/main/$($script:ModelFileName)"
    )
    $downloaded = $false
    foreach ($url in $urls) {
        Write-Host "Downloading $url" -ForegroundColor Yellow
        & curl.exe -L --retry 8 --retry-delay 3 -C - --fail -o $script:ModelFile $url
        if ($LASTEXITCODE -eq 0 -and ((Get-FileSizeBytes $script:ModelFile) -gt 4GB)) {
            $downloaded = $true
            break
        }
    }
    if (-not $downloaded) {
        throw "Failed to download $($script:ModelFileName)."
    }
}

$modelSize = Get-FileSizeBytes $script:ModelFile
if ($modelSize -lt 4GB) {
    throw "Model file looks incomplete ($modelSize bytes): $($script:ModelFile)"
}

Write-Host ("Local llama.cpp setup completed. Model {0:N1} GB at {1}" -f ($modelSize / 1GB), $script:ModelFile) -ForegroundColor Green
Write-Host "Start it with start_local_llm.ps1 (OpenAI-compatible http://$($script:LlmHost):$($script:LlmPort)/v1, alias $($script:ModelAlias))."
