# Loads the x64 Visual Studio developer environment (vcvars64.bat) into the current
# PowerShell session and puts the CMake and Ninja bundled with Visual Studio on PATH.
# Only the current process is affected.
function Import-VsDevEnv {
    if ($env:VSCMD_VER -and (Get-Command cl.exe -ErrorAction SilentlyContinue)) { return }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found; Visual Studio (Build Tools) with C++ is required" }
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vs) { throw "No Visual Studio installation with the MSVC x64 toolset found" }
    $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
    $lines = cmd /c "`"$vcvars`" >nul 2>&1 && set"
    foreach ($l in $lines) {
        $i = $l.IndexOf('=')
        if ($i -gt 0) { Set-Item -Path ("env:" + $l.Substring(0, $i)) -Value $l.Substring($i + 1) }
    }
    $cmakeBin = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
    $ninjaBin = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja'
    $env:PATH = "$cmakeBin;$ninjaBin;$env:PATH"
}
