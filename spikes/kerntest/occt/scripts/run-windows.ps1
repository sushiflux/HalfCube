# Runs the Windows kernel test build. All arguments are passed to kerntest_occt.exe
# (a leading "-NoStep" selects the build without STEP).
# Examples:
#   run-windows.ps1 run --runs 5 --out <dir> --json <results.json>
#   run-windows.ps1 p5b --in part.step --out part-cut.step --json part.json
# Plain $args is used on purpose: an advanced param block would capture "--out" as -OutVariable.
$ErrorActionPreference = 'Stop'

$ktArgs = @($args)
$name = 'occt-tests-win'
if ($ktArgs.Count -gt 0 -and $ktArgs[0] -eq '-NoStep') {
    $name = 'occt-tests-win-nostep'
    $ktArgs = @($ktArgs | Select-Object -Skip 1)
}
$kerntest = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exe  = Join-Path $kerntest "_build\$name\kerntest_occt.exe"
$bin  = Join-Path $kerntest '_build\occt-win-install\win64\vc14\bin'
if (-not (Test-Path $exe)) { throw "Test program missing: $exe. Run build-tests-windows.ps1 first." }
$env:PATH = "$bin;$env:PATH"
& $exe @ktArgs
exit $LASTEXITCODE
