[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$OllamaExe = 'D:\Program Files\Ollama\ollama.exe'
$ModelName = 'novastory-qwen3:8b'

if (-not (Test-Path -LiteralPath $OllamaExe -PathType Leaf)) {
    $command = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if (-not $command) {
        Write-Host 'Ollama is not installed; no model memory needs to be released.'
        exit 0
    }
    $OllamaExe = $command.Source
}

try {
    & $OllamaExe stop $ModelName 2>$null
}
catch {
    # An unavailable Ollama server already means no Ollama model is using VRAM.
}

Write-Host "Released Ollama model memory: $ModelName" -ForegroundColor Green
