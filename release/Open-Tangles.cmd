@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "APP=%~dp0tangles-local-win.exe"
if not exist "%APP%" (
  echo Could not find tangles-local-win.exe in:
  echo %~dp0
  pause
  exit /b 1
)

set "RUNNING="
for /f "tokens=2 delims=," %%a in ('tasklist /FI "IMAGENAME eq tangles-local-win.exe" /FO CSV /NH') do (
  set "RUNNING=1"
)

if not defined RUNNING (
  start "" "%APP%" --no-open
  timeout /t 1 /nobreak >nul
)

set "URL="
for %%P in (8787 8788 8789 8790 8791 8792 8793 8794 8795 8796) do (
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%%P/api/state' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
  if !errorlevel! equ 0 (
    set "URL=http://127.0.0.1:%%P"
    goto :open
  )
)

:open
if not defined URL set "URL=http://127.0.0.1:8787"
start "" "!URL!"
endlocal
