@echo off
setlocal
chcp 65001 >nul
title Typeless Toolkit - public release
rem 脚本位于 build/ 子目录: 切回仓库根, 保证 package.json 等相对路径可解析
cd /d "%~dp0.."

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-public-release.ps1"
exit /b %errorlevel%
