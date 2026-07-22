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
