@echo off
rem Stops Onion Player if it is running in the background.
set PORT=%ONION_PORT%
if "%PORT%"=="" set PORT=8765
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; 'Onion Player stopped.' } else { 'Onion Player was not running.' }"
timeout /t 3 >nul
