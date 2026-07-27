# Stops whatever process is listening on the app's port.
#
# Why this exists: `npm start` on Windows runs `node server.js` through an
# extra `cmd.exe` layer (npm's own wrapper), not as a direct child of your
# terminal. Closing the terminal window doesn't reliably kill that
# grandchild process -- it can detach and keep running, still holding the
# port, with nothing left in any terminal to Ctrl+C. This script finds that
# process by port (not by name -- "node.exe" could be anything, including
# an unrelated Node process) and stops it directly.
#
# Usage:
#   npm run stop            (uses the default port, or reads .env's PORT)
#   npm run stop -- -Port 4000
#
# Two-step shutdown, matching server.js's SIGINT/SIGTERM handler:
#   1. `Stop-Process` (no -Force) first -- on Windows this asks a console
#      app to close via its console control handler, which is what lets
#      Node's process.on("SIGINT"/"SIGTERM") in server.js actually run (and
#      close the DB cleanly) instead of the process just vanishing mid-write.
#      This is NOT the same guarantee as a POSIX `kill -TERM`; Windows has no
#      real signal delivery between unrelated processes, so this sometimes
#      doesn't work depending on how the target process's console is set up.
#   2. If the process is still there after a couple seconds, `Stop-Process
#      -Force` (this is what `taskkill /F` does under the hood) -- a hard
#      kill, guaranteed to work, but skips server.js's cleanup.

param(
    [int]$Port = $null
)

if (-not $Port) {
    $Port = 3113
    $envFile = Join-Path $PSScriptRoot "..\.env"
    if (Test-Path $envFile) {
        $match = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
        if ($match) { $Port = [int]$match.Matches[0].Groups[1].Value }
    }
}

Write-Host "Looking for a process listening on port $Port..."

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host "Nothing is listening on port $Port. Nothing to stop."
    exit 0
}

$processIds = $conns | Select-Object -ExpandProperty OwningProcess -Unique

foreach ($pid in $processIds) {
    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if (-not $proc) { continue }

    Write-Host "Found $($proc.ProcessName) (PID $pid) on port $Port."
    Write-Host "Requesting graceful shutdown..."
    try {
        Stop-Process -Id $pid -ErrorAction Stop
    } catch {
        Write-Host "  Graceful request failed ($($_.Exception.Message)) -- will force-kill instead."
    }

    Start-Sleep -Seconds 2

    if (Get-Process -Id $pid -ErrorAction SilentlyContinue) {
        Write-Host "Still running after 2s -- force-killing PID $pid."
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }

    if (Get-Process -Id $pid -ErrorAction SilentlyContinue) {
        Write-Host "WARNING: PID $pid is still running. You may need to close it from Task Manager."
    } else {
        Write-Host "Stopped PID $pid."
    }
}
