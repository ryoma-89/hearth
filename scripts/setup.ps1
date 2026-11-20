# Hearth setup for Windows. Safe to re-run.
# - checks Node.js >= 24.9
# - installs npm dependencies (DeepSeek Harness is pinned in package.json)
# - creates hearth.yaml from the example if missing
# - runs local diagnostics
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$nodeVersion = (& node --version) -replace '^v', ''
if ([version]$nodeVersion -lt [version]'24.9.0') {
    Write-Error "Node.js 24.9 or newer is required (found $nodeVersion). Install it from https://nodejs.org/"
}
Write-Host "Node.js $nodeVersion OK"

Write-Host 'Installing dependencies (first run downloads about 1.3 GB)...'
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Error 'npm install failed' }

if (-not (Test-Path (Join-Path $root 'hearth.yaml'))) {
    Copy-Item (Join-Path $root 'config\hearth.example.yaml') (Join-Path $root 'hearth.yaml')
    Write-Host 'Created hearth.yaml from config\hearth.example.yaml - review it before the first run.'
}

& node (Join-Path $root 'bin\hearth.mjs') doctor --no-probe
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Store the STRATA API key:   .\scripts\hearth.ps1 secret set strata'
Write-Host '  2. Check the model connection: .\scripts\hearth.ps1 doctor'
Write-Host '  3. Run a task:                 .\scripts\hearth.ps1 run "..." --workspace E:\path\to\project'
