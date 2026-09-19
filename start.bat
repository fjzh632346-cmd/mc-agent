@echo off
chcp 65001 >nul
title Minecraft AI 伙伴启动器

echo.
echo  ==========================================
echo     Minecraft AI 伙伴  启动器
echo  ==========================================
echo.

echo [步骤1] 正在清理残留 node 进程...
taskkill /F /IM node.exe >nul 2>&1
echo [步骤1] 完成 (有没有残留都继续)

echo.
echo [步骤2] 正在读取 .env 中的当前人设...

set PERSONA_VAL=andy
for /f "tokens=1,2 delims==" %%A in (.env) do (
    if /i "%%A"=="PERSONA" set PERSONA_VAL=%%B
)

set PERSONA_NAME=未知
if /i "%PERSONA_VAL%"=="linxia" set PERSONA_NAME=林夏
if /i "%PERSONA_VAL%"=="zhiyu"  set PERSONA_NAME=沈知雨
if /i "%PERSONA_VAL%"=="sumu"   set PERSONA_NAME=苏霂
if /i "%PERSONA_VAL%"=="suzu"   set PERSONA_NAME=雪之下铃
if /i "%PERSONA_VAL%"=="andy"   set PERSONA_NAME=中性安迪

echo [步骤2] 读取完成，当前人设: %PERSONA_VAL% (%PERSONA_NAME%)

set VOICE_VAL=false
for /f "tokens=1,2 delims==" %%A in (.env) do (
    if /i "%%A"=="VOICE_INPUT_ENABLED" set VOICE_VAL=%%B
)
if /i "%VOICE_VAL%"=="true" (
    echo [语音] 语音输入: 启用 ^(按住 V 说话^)
) else (
    echo [语音] 语音输入: 已关闭 ^(改 .env VOICE_INPUT_ENABLED=true 启用^)
)
echo.

echo 要切换人设吗?
set /p SWITCH=[Y/N] (直接回车=不切): 
if /i "%SWITCH%"=="Y" goto :choosepersona
goto :skipswitch

:choosepersona
echo.
echo  [1] 林夏     [2] 沈知雨   [3] 苏霂
echo  [4] 雪之下铃 [5] 中性安迪
echo.
set /p PCHOICE=输入数字选择人设: 

set NEW_PERSONA=
if "%PCHOICE%"=="1" set NEW_PERSONA=linxia
if "%PCHOICE%"=="2" set NEW_PERSONA=zhiyu
if "%PCHOICE%"=="3" set NEW_PERSONA=sumu
if "%PCHOICE%"=="4" set NEW_PERSONA=suzu
if "%PCHOICE%"=="5" set NEW_PERSONA=andy

if "%NEW_PERSONA%"=="" goto :invalidchoice
goto :dopersona

:invalidchoice
echo [人设] 输入无效，保持当前人设: %PERSONA_VAL%
goto :skipswitch

:dopersona
echo [人设] 正在切换到: %NEW_PERSONA% ...
powershell -NoProfile -Command "(Get-Content .env -Encoding UTF8) -replace '`^PERSONA=.*', 'PERSONA=%NEW_PERSONA%' | Set-Content .env -Encoding UTF8"
echo [人设] 切换完成

:skipswitch
echo [步骤3] 人设确认完毕，准备启动...
echo.
echo [步骤3] 请确认 Minecraft 已开启局域网:
echo   进入游戏 -^> ESC -^> 对局域网开放
echo.
pause

echo.
echo === 启动 bot ===
node bot.js
echo === bot 已退出，退出码: %ERRORLEVEL% ===

echo.
pause
