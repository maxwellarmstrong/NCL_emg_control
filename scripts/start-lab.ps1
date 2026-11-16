param([int]$Port = 8081, [string]$DataDir)
$ErrorActionPreference = 'Stop'
$emgRoot = Split-Path -Parent $PSScriptRoot
$emgPython = Join-Path $emgRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $emgPython)) { throw 'Run the setup steps in RESEARCH.md first.' }
Push-Location $emgRoot
$emgArguments = @('-m', 'emg_research.server', '--port', $Port)
if ($DataDir) { $emgArguments += @('--data-dir', $DataDir) }
try { & $emgPython @emgArguments }
finally { Pop-Location }
