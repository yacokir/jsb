@echo off
setlocal EnableExtensions EnableDelayedExpansion

if defined JSB_ALOP_CHILD_INSTANCE goto run_instance

set "script_path=%~f0"
set "script_dir=%~dp0"
set "arg_count=0"

:count_args
if "%~1"=="" goto args_counted
set /a arg_count+=1 >nul
if !arg_count! GTR 6 goto usage
set "arg!arg_count!=%~1"
set "mode=%~1"
shift
goto count_args

:args_counted
if !arg_count! LSS 2 goto usage
if /i not "!mode!"=="opening" if /i not "!mode!"=="test" goto usage

set /a symbol_count=arg_count-1
set "JSB_ALOP_CHILD_INSTANCE=1"

for /l %%I in (1,1,!symbol_count!) do (
    set "symbol=!arg%%I!"
    set "window_title=ALOP - !symbol! - !mode!"
    reg add "HKCU\Console\!window_title!" /v WindowSize /t REG_DWORD /d 0x0020006e /f >nul 2>&1
    reg add "HKCU\Console\!window_title!" /v ScreenBufferSize /t REG_DWORD /d 0x0bb8006e /f >nul 2>&1
    start "!window_title!" /D "!script_dir!" cmd.exe /d /k call "!script_path!" "!symbol!" "!mode!"
)

exit /b 0

:run_instance
title ALOP - %~1 - %~2
node alop.js "%~1" "%~2"
exit /b %errorlevel%

:usage
echo Uso:
echo   alop.bat SYMBOL1 [SYMBOL2] [SYMBOL3] [SYMBOL4] [SYMBOL5] opening
echo   alop.bat SYMBOL1 [SYMBOL2] [SYMBOL3] [SYMBOL4] [SYMBOL5] test
exit /b 1
