[CmdletBinding()]
param(
    [switch]$StopLlm,
    [switch]$KeepLlm
)

$RootDir = $PSScriptRoot
if ($StopLlm -and -not $KeepLlm) {
    $stopLlm = Join-Path $RootDir 'stop_local_llm.ps1'
    if (Test-Path -LiteralPath $stopLlm -PathType Leaf) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopLlm
    }
}

$settingsPath = if ($env:NOVASTORY_CONFIG_DIR) {
    Join-Path $env:NOVASTORY_CONFIG_DIR 'system_settings.json'
} else {
    Join-Path $RootDir 'backend\system_settings.json'
}
$comfyDir = 'D:\ComfyUI'
$port = 8188
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    try {
        $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($settings.comfyui.install_path) { $comfyDir = [string]$settings.comfyui.install_path }
        $url = if ($settings.comfyui.local_base_url) { [string]$settings.comfyui.local_base_url } else { [string]$settings.comfyui.base_url }
        if ($url -match ':(\d+)(?:/|$)') { $port = $Matches[1] }
    } catch {
        Write-Host "Could not read ComfyUI settings at $settingsPath; using $comfyDir port $port." -ForegroundColor Yellow
    }
}

$pythonExe = Join-Path $comfyDir 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
    $pythonExe = 'python.exe'
}

$command = "chcp 65001 >nul && title ComfyUI Server ($port) && cd /d `"$comfyDir`" && `"$pythonExe`" main.py --listen 127.0.0.1 --port $port --lowvram --disable-pinned-memory --cache-none"
Start-Process -FilePath $env:ComSpec -ArgumentList @('/k', $command) -WorkingDirectory $comfyDir | Out-Null
Write-Host "ComfyUI dispatched on http://127.0.0.1:$port" -ForegroundColor Green
