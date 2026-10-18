@echo off
rem Keeps the log files small: any log above 2 MB is cut down to its last 1000 lines. Called at the start of each scheduled run.
cd /d "%~dp0.."
if not exist data\logs exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem 'data\logs\*.log' | Where-Object { $_.Length -gt 2MB } | ForEach-Object { $t = Get-Content -LiteralPath $_.FullName -Tail 1000; Set-Content -LiteralPath $_.FullName -Value $t }" >nul 2>&1
exit /b 0
