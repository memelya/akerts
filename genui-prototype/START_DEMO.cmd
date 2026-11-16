@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
 py -3 "%~dp0start_demo.py"
) else (
 where python >nul 2>nul
 if errorlevel 1 (
  echo Python 3.10 or newer is required. Install Python, then run this file again.
  pause
  exit /b 1
 )
 python "%~dp0start_demo.py"
)
if errorlevel 1 pause
