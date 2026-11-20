# Hearth launcher for PowerShell: .\scripts\hearth.ps1 <command> [options]
$root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $root 'bin\hearth.mjs') @args
exit $LASTEXITCODE
