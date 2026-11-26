# Starts a program hidden and records every top-level window that any process of the test app (or the started
# program itself) owns while it runs: class, visibility, size, extended style. Used to tell a real window from a
# zero-size helper window.
#   powershell -File scripts\watch-windows.ps1 -File <exe> [-ArgList a,b]
param([Parameter(Mandatory)][string]$File, [string[]]$ArgList = @())
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  public static List<string> ForPids(HashSet<uint> pids) {
    var o = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid)) {
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        RECT r; GetWindowRect(h, out r);
        o.Add(string.Format("pid={0} class='{1}' title='{2}' visible={3} size={4}x{5} pos={6},{7} exstyle=0x{8:X}", pid, c, t, IsWindowVisible(h), r.R - r.L, r.B - r.T, r.L, r.T, GetWindowLong(h, -20)));
      }
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
'@
$sp = @{ FilePath = $File; WindowStyle = 'Hidden'; PassThru = $true }
if ($ArgList.Count) { $sp.ArgumentList = $ArgList }
$p = Start-Process @sp
$seen = [ordered]@{}
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 120) {
  $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
  foreach ($q in Get-Process -ErrorAction SilentlyContinue) {
    if (($q.Path -and $q.Path -like '*HalfCubeVelopackTest*') -or $q.Id -eq $p.Id -or $q.ProcessName -like 'Setup-*') { [void]$pids.Add([uint32]$q.Id) }
  }
  foreach ($line in [Win]::ForPids($pids)) { $seen[$line] = 1 }
  if ($p.HasExited -and $pids.Count -eq 0) { break }
  Start-Sleep -Milliseconds 50
}
"exit code of started program: $($p.ExitCode) after $([math]::Round($sw.Elapsed.TotalSeconds,1)) s"
if ($seen.Count) { $seen.Keys } else { 'no top-level windows seen' }
