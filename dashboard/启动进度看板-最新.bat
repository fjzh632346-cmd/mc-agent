@echo off
rem 后勤线那份看板（板子数据最新，比主仓那份早一个合并轮）。
rem 协作文件仍然读主仓，所以三条线的进度、任务书、待拍板都是实时的。
rem 主仓那份 启动进度看板.bat 照旧能用，只是板子数据停在上次合并。
cd /d "%~dp0.."
set "MC_DASHBOARD_ROOT=D:\code\MC-blueprint-ir-v1"
echo.
echo   Starting project dashboard (ops copy, latest board data)...
echo   Reading collaboration files from %MC_DASHBOARD_ROOT%
echo   Your browser will open at http://localhost:4321
echo   Close this black window to stop it.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:4321"
node dashboard\server.js
echo.
echo   Dashboard stopped.
pause
