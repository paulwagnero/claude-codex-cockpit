@echo off
rem Double-click to open Claude Codex Cockpit. Starts Electron detached, so this console closes right away.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
