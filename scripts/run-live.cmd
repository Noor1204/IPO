@echo off
rem Hourly refresh: NSE (no document downloads), GMP, SEBI, Yahoo prices, verification, build. Log: data\logs\live.log
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
echo ==== %date% %time% ==== >> data\logs\live.log
call npm run live >> data\logs\live.log 2>&1
echo exit code %errorlevel% >> data\logs\live.log
