param([int]$Port = 4318)
$ErrorActionPreference = 'Stop'
try {
    $runningMonitor = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    if ($runningMonitor.service -ne 'codex-token-monitor') { throw 'This port is not a Codex Token Monitor.' }
    $monitorProcess = Get-Process -Id $runningMonitor.pid -ErrorAction Stop
    if ($monitorProcess.ProcessName -ne 'node') { throw 'The monitor process could not be verified.' }
    Stop-Process -Id $monitorProcess.Id
    Write-Host "Token monitor stopped on port $Port."
} catch {
    Write-Host "No verified token monitor could be stopped on port $Port."
    Write-Host $_.Exception.Message
}
