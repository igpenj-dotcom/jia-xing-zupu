@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   佳兴族谱 - 本地服务
echo   启动后请用浏览器打开 http://127.0.0.1:8765
echo   默认账号：admin    默认密码：Admin123456
echo   关闭此窗口即停止服务
echo ==========================================
python server.py
if errorlevel 1 (
  echo.
  echo 启动失败：请确认已安装 Python 3，并将其加入 PATH。
  pause
)
