[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-llm\runtime.ps1')

Stop-LocalLlmServer
Write-Host "Released llama.cpp model memory: $($script:ModelAlias)" -ForegroundColor Green
