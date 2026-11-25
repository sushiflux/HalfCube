# Helpers for the Velopack test: run a program hidden, watch it (and the processes it starts) for visible windows,
# and report exit code, duration and whether anything was shown.
function Get-RelatedProcesses {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like '*PartcraftVelopackTest*' -or $_.ProcessName -like 'Setup-*' }
}

function Invoke-Watched {
  param([string]$File, [string[]]$ArgList = @(), [int]$TimeoutSec = 300, [string]$Label = $File)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $sp = @{ FilePath = $File; WindowStyle = 'Hidden'; PassThru = $true }
  if ($ArgList.Count -gt 0) { $sp.ArgumentList = $ArgList }
  $p = Start-Process @sp
  $windows = [ordered]@{}; $procs = [ordered]@{}
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    foreach ($q in (Get-RelatedProcesses)) {
      $procs["$($q.ProcessName)"] = 1
      if ($q.MainWindowHandle -ne 0) { $windows["$($q.ProcessName): '$($q.MainWindowTitle)'"] = 1 }
    }
    if ($p.HasExited) { break }
    Start-Sleep -Milliseconds 100
  }
  $p.WaitForExit()
  [pscustomobject]@{
    Label = $Label; ExitCode = $p.ExitCode; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    Processes = ($procs.Keys -join ', '); VisibleWindows = if ($windows.Count) { $windows.Keys -join '; ' } else { 'none' }
  }
}

# Waits until no process of the test app (installed copy, updater, setup) is running any more.
function Wait-Idle {
  param([int]$TimeoutSec = 120)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    if (-not (Get-RelatedProcesses)) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}
