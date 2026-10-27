@echo off
setlocal
cd /d "%~dp0"
title Onion Player

if not exist ".venv\Scripts\python.exe" (
  echo First run: setting up the Python environment. This takes a minute...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if errorlevel 1 (
    echo Could not create a virtual environment. Install Python 3.10 or newer from python.org first.
    pause
    exit /b 1
  )
)

call ".venv\Scripts\activate.bat"
python -m pip install -q --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
  echo Installing the packages failed. Check your internet connection and try again.
  pause
  exit /b 1
)

python app.py
pause
