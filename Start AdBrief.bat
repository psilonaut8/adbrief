@echo off
title AdBrief
echo Starting AdBrief...
cd /d "%~dp0"
taskkill /f /im node.exe >nul 2>&1
timeout /t 1 /nobreak >nul
start "" http://localhost:3000
node server.js
pause
