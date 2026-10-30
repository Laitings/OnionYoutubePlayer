@echo off
rem Stops Onion Player if it is running in the background (every copy started from this folder).
powershell -NoProfile -Command "$dir = '%~dp0'.TrimEnd([char]92); $found = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^pythonw?\.exe$' -and $_.CommandLine -like '*app.py*' -and $_.CommandLine -like ('*' + $dir + '*') }); $found | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; if ($found) { 'Onion Player stopped.' } else { 'Onion Player was not running.' }"
timeout /t 3 >nul
