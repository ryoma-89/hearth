@echo off
rem Hearth launcher for cmd.exe and for other tools (Claude Code, Codex) that call it as an external command.
node "%~dp0..\bin\hearth.mjs" %*
exit /b %ERRORLEVEL%
