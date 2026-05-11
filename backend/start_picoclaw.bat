@echo off
echo ========================================================
echo   PicoClaw Startup Script
echo ========================================================
echo.
echo Checking for Go language installation...

cd ..\picoclaw-main
go version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Go is not installed on your computer.
    echo PicoClaw is written in Go, not Python. You must install the Go compiler to build and run it.
    echo Download it here: https://go.dev/dl/
    echo.
    pause
    exit /b
)

echo [OK] Go is installed. Building PicoClaw...
echo (This might take a minute...)
go build -o picoclaw.exe

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to compile PicoClaw.
    pause
    exit /b
)

echo [OK] Build successful!
echo.
echo Starting PicoClaw Gateway on port 18790...
echo Keep this window open while using the CRM.
echo.
picoclaw.exe gateway
pause
