param([int]$Port = 8081)
$ErrorActionPreference = 'Stop'
$emgRoot = Split-Path -Parent $PSScriptRoot
$emgPython = Join-Path $emgRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $emgPython)) { throw 'Run the setup steps in RESEARCH.md first.' }
Push-Location $emgRoot
try { & $emgPython -m emg_research.server --port $Port }
finally { Pop-Location }
