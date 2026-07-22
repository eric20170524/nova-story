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
