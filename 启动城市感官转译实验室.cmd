@echo off
if not exist "%~dp0dist\index.html" (
  echo Run npm run build in this folder first.
  pause
  exit /b 1
)
start "" "%~dp0dist\index.html"

