@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto missing_node
node -e "if (Number(process.versions.node.split('.')[0]) !== 24) process.exit(1)"
if errorlevel 1 goto missing_node
where npm >nul 2>&1
if errorlevel 1 goto missing_node
if exist node_modules goto start
echo Installing local app dependencies. First launch requires internet.
call npm ci
if errorlevel 1 goto install_failed
:start
echo Starting メモパレ. Keep this window open. Stop with Ctrl+C.
node server.mjs
set "LINKFLOW_MEMO_EXIT=%ERRORLEVEL%"
if not "%LINKFLOW_MEMO_EXIT%"=="0" echo The service stopped with an error. Saved notes remain in the data folder.
pause
exit /b %LINKFLOW_MEMO_EXIT%
:missing_node
echo Node.js 24 LTS including npm is required. Install it from https://nodejs.org/ and reopen this file.
pause
exit /b 1
:install_failed
echo Dependency installation failed. Your saved notes were not removed.
pause
exit /b 1
