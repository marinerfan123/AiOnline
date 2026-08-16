@echo off
cd /d "%~dp0"
echo 正在启动画布后端 (http://localhost:3001) ...
echo 关闭此窗口即可停止服务。
echo.
node server/server.js
pause
