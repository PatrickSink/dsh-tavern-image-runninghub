@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-plugin.ps1" %*
set "install_exit=%ERRORLEVEL%"
echo.
if not "%install_exit%"=="0" echo 安装未完成，请查看上面的原因。
pause
exit /b %install_exit%
