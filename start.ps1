$ErrorActionPreference = 'Stop'
try {
    $existingMonitor = Invoke-RestMethod -Uri 'http://127.0.0.1:4318/api/health' -TimeoutSec 2
    if ($existingMonitor.service -eq 'codex-token-monitor') {
        Start-Process 'http://127.0.0.1:4318'
        exit 0
    }
} catch {}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Write-Host 'Node.js 20 or later is required.'
    Read-Host 'Press Enter to exit'
    exit 1
}
Set-Location -LiteralPath $PSScriptRoot
& $nodeCommand.Source (Join-Path $PSScriptRoot 'server.mjs') --open
