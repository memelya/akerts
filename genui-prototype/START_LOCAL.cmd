@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
 py -3 "%~dp0launch_local.py" --port 8015
) else (
 where python >nul 2>nul
 if errorlevel 1 (
  echo Python 3.10 or newer is required. Install Python, then run this file again.
  pause
  exit /b 1
 )
 python "%~dp0launch_local.py" --port 8015
)
if errorlevel 1 pause
