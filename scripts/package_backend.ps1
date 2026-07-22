$ErrorActionPreference = "Stop"

$scriptPath = $PSScriptRoot
$rootPath = Split-Path $scriptPath -Parent
$backendPath = Join-Path $rootPath "backend"
$releaseDir = Join-Path $rootPath "release"
$stageDir = Join-Path $releaseDir "backend"
$zipPath = Join-Path $releaseDir "backend_deploy.zip"

Write-Host "Packaging NovaStory Backend..."
Write-Host "Source: $backendPath"
Write-Host "Destination: $stageDir"

# 1. Prepare Release Directory
if (Test-Path $releaseDir) {
    Remove-Item -Path $releaseDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDir | Out-Null

# 2. Copy Files (Excluding .venv, __pycache__, .git, etc.)
$exclude = @(".venv", "__pycache__", ".git", ".idea", "*.pyc", "logs", "tmp", ".env", "generated", "tests", ".pytest_cache")

Get-ChildItem -Path $backendPath -Recurse | Where-Object {
    $path = $_.FullName
    $skip = $false
    foreach ($pattern in $exclude) {
        if ($path -like "*\$pattern*" -or $path -like "*\$pattern") {
            $skip = $true
            break
        }
    }
    return -not $skip
} | ForEach-Object {
    $relativePath = $_.FullName.Substring($backendPath.Length + 1)
    $destPath = Join-Path $stageDir $relativePath
    
    if ($_.PSIsContainer) {
        if (-not (Test-Path $destPath)) {
            New-Item -ItemType Directory -Path $destPath | Out-Null
        }
    } else {
        Copy-Item -Path $_.FullName -Destination $destPath
    }
}

# 3. Create build.bat
$buildContent = @"
@echo off
setlocal
cd /d %~dp0

echo ==========================================
echo  NovaStory Backend Setup
echo ==========================================

if exist .venv (
    echo [INFO] Virtual environment already exists.
    set /p REINSTALL="Do you want to reinstall? (y/n): "
    if /i "%REINSTALL%" neq "y" goto :skip_venv
    rmdir /s /q .venv
)

echo [INFO] Creating Python virtual environment...
python -m venv .venv
if %errorlevel% neq 0 (
    echo [ERROR] Failed to create virtual environment. Ensure python is installed and in PATH.
    pause
    exit /b %errorlevel%
)

:skip_venv
echo [INFO] Activating virtual environment...
call .venv\Scripts\activate

echo [INFO] Upgrading pip...
python -m pip install --upgrade pip

echo [INFO] Installing dependencies from requirements.txt...
pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b %errorlevel%
)

echo.
echo [SUCCESS] Environment setup complete.
echo [NEXT STEP] 1. Create a .env file (if needed) or configure system_settings.json.
echo             2. Run start.bat to launch the server.
pause
"@
Set-Content -Path (Join-Path $stageDir "build.bat") -Value $buildContent -Encoding ASCII

# 4. Create start.bat
$startContent = @"
@echo off
setlocal
cd /d %~dp0

if not exist .venv (
    echo [ERROR] Virtual environment not found. Please run build.bat first.
    pause
    exit /b 1
)

echo [INFO] Activating virtual environment...
call .venv\Scripts\activate

echo [INFO] Applying database migrations...
alembic upgrade head
if %errorlevel% neq 0 (
    echo [WARNING] Database migration failed or no database connection. Check configuration.
    timeout /t 5
)

echo [INFO] Starting Uvicorn server...
echo [INFO] API Documentation: http://localhost:8087/docs
uvicorn main:app --host 0.0.0.0 --port 8087

pause
"@
Set-Content -Path (Join-Path $stageDir "start.bat") -Value $startContent -Encoding ASCII

# 5. Zip the package
Write-Host "Zipping package to $zipPath ..."
Compress-Archive -Path $stageDir -DestinationPath $zipPath

Write-Host "------------------------------------------------"
Write-Host "Deployment package created successfully!"
Write-Host "Location: $zipPath"
Write-Host "------------------------------------------------"
