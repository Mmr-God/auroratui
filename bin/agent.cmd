@echo off
rem AuroraTui -- Windows launcher (UTF-8 code page + real console for the TUI)
setlocal
chcp 65001 >nul 2>&1
title AuroraTui
set "AGENT_ROOT=%~dp0.."
node "%AGENT_ROOT%\bin\agent.js" %*
endlocal
