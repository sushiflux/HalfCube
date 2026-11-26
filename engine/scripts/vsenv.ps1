# Imports the 64-bit MSVC developer environment (vcvars64.bat) into the current PowerShell session.
# Finds Visual Studio 2022 (or newer) or its Build Tools with vswhere; no installation path is hard-coded.
# The CMake and Ninja that ship with Visual Studio are put on PATH when none is found there.
$ErrorActionPreference = 'Stop'

if (-not ($env:VSCMD_VER -and (Get-Command cl.exe -ErrorAction SilentlyContinue))) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) {
        throw "vswhere.exe not found at $vswhere. Install Visual Studio 2022 or its Build Tools with the workload 'Desktop development with C++'."
    }
    $vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsRoot) { throw "No Visual Studio installation with the C++ x64 build tools found (vswhere). Install the workload 'Desktop development with C++'." }
    $vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
    if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found: $vcvars" }
    $lines = & cmd.exe /c "`"$vcvars`" >nul 2>&1 && set"
    if ($LASTEXITCODE -ne 0) { throw "vcvars64.bat failed with exit code $LASTEXITCODE" }
    foreach ($line in $lines) {
        $i = $line.IndexOf('=')
        if ($i -gt 0) { Set-Item -Path ("Env:" + $line.Substring(0, $i)) -Value $line.Substring($i + 1) }
    }
    $script:HcVsRoot = $vsRoot
}
if (-not (Get-Command cmake -ErrorAction SilentlyContinue) -or -not (Get-Command ninja -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $ext = Join-Path $vsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake'
    foreach ($p in @((Join-Path $ext 'CMake\bin'), (Join-Path $ext 'Ninja'))) {
        if ((Test-Path $p) -and -not ($env:PATH.Split(';') -contains $p)) { $env:PATH = "$p;$env:PATH" }
    }
}
foreach ($tool in 'cl', 'cmake', 'ninja') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found after loading the MSVC environment." }
}
