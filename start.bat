@echo off
setlocal
cd /d "%~dp0"
where claude >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Claude Code CLI not found on PATH.
  echo      Install with:  npm install -g @anthropic-ai/claude-code
  echo      Then sign in:  claude login
  echo.
  pause
  exit /b 1
)
echo  Starting AgentEye Hub bridge...
echo.
start "" http://localhost:7860
node server.js
