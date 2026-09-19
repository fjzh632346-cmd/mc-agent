@echo off
cd /d "%~dp0.."
echo.
echo   Starting project dashboard...
echo   Your browser will open at http://localhost:4321
echo   Close this black window to stop it.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:4321"
node dashboard\server.js
echo.
echo   Dashboard stopped.
pause
