@echo off
rem Daily full refresh: also downloads offer documents (NSE + SEBI), re-cuts sections, extracts new fundamentals
rem (extraction needs a logged-in Claude CLI or ANTHROPIC_API_KEY), verifies and builds. Log: data\logs\daily.log
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
echo ==== %date% %time% ==== >> data\logs\daily.log
call npm run refresh >> data\logs\daily.log 2>&1
echo exit code %errorlevel% >> data\logs\daily.log
call scripts\push-data.cmd
