@echo off
chcp 65001 >nul
echo 正在停止「佳兴族谱」服务...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq '佳兴族谱.exe') -or ($_.CommandLine -like '*server.py*' -and $_.Name -like 'python*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo 已停止。再次使用请双击「佳兴族谱.exe」。
timeout /t 2 >nul
