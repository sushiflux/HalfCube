# Imports the 64-bit MSVC developer environment (vcvars64.bat) into the current PowerShell session.
# Uses vswhere to locate Visual Studio or the Build Tools; no hard-coded installation path.
$ErrorActionPreference = 'Stop'

if ($env:VSCMD_VER -and (Get-Command cl.exe -ErrorAction SilentlyContinue)) { return }

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found at $vswhere - install Visual Studio 2022 or its Build Tools with the C++ workload." }
$vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw 'No Visual Studio installation with the C++ x64 toolset found (vswhere).' }
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found: $vcvars" }

$lines = & cmd.exe /c "`"$vcvars`" >nul 2>&1 && set"
if ($LASTEXITCODE -ne 0) { throw "vcvars64.bat failed with exit code $LASTEXITCODE" }
foreach ($line in $lines) {
    $i = $line.IndexOf('=')
    if ($i -gt 0) { Set-Item -Path ("Env:" + $line.Substring(0, $i)) -Value $line.Substring($i + 1) }
}

# The CMake and Ninja that ship with Visual Studio are used when none is on PATH.
$cmakeExt = Join-Path $vsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake'
foreach ($p in @((Join-Path $cmakeExt 'CMake\bin'), (Join-Path $cmakeExt 'Ninja'))) {
    if ((Test-Path $p) -and -not ($env:PATH.Split(';') -contains $p)) { $env:PATH = "$p;$env:PATH" }
}
