@echo off
rem AuroraTui -- ACP (Agent Client Protocol) launcher for IDE integration.
rem
rem The editor (OpenIDEA / Zed) launches this file as the ACP agent command:
rem   stdout = JSON-RPC channel, must stay clean, so no helper output here.
rem   stderr = logs, the client may show them.
rem
rem Usage: acp.cmd
rem        acp.cmd --provider deepseek --model deepseek-flash   (optional)
rem
rem NOTE: keep this file pure ASCII. cmd.exe parses comments before chcp
rem takes effect, so non-ASCII comments break parsing on GBK consoles.
setlocal
chcp 65001 >nul 2>&1
set "AGENT_ROOT=%~dp0.."

set "NODE_BIN=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "D:\node-v24.19.0-win-x64\node.exe" set "NODE_BIN=D:\node-v24.19.0-win-x64\node.exe"
)

"%NODE_BIN%" "%AGENT_ROOT%\bin\agent.js" --acp %*
endlocal
