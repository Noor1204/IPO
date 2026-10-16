@echo off
rem Backup route to the live site: after a refresh on this PC, check the data and push it to GitHub.
rem Does nothing until a GitHub remote named "origin" has been added. A failure here never stops the refresh. Log: data\logs\push.log
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
git rev-parse --is-inside-work-tree >nul 2>&1 || exit /b 0
git remote get-url origin >nul 2>&1 || exit /b 0
echo ==== %date% %time% ==== >> data\logs\push.log
call node pipeline\validate.mjs >> data\logs\push.log 2>&1
if errorlevel 1 (
  echo data failed the check, NOT pushing >> data\logs\push.log
  exit /b 0
)
git add data/ipos.json data/gmp.json data/sub-history.json data/quotes.json data/sebi.json data/bse.json data/nse.json data/nse-history.json data/offer-docs.json data/verify.json data/fundamentals data/logos data/logos.json >> data\logs\push.log 2>&1
git diff --cached --quiet && (echo nothing new to push >> data\logs\push.log & exit /b 0)
git commit -q -m "data: refresh from PC %date% %time%" >> data\logs\push.log 2>&1
rem the cloud job also commits data: on a clash this PC's newer files win
git pull --rebase -X theirs -q origin main >> data\logs\push.log 2>&1
git push -q origin main >> data\logs\push.log 2>&1
echo push exit code %errorlevel% >> data\logs\push.log
exit /b 0
