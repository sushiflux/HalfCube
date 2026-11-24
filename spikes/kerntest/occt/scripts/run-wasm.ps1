# Runs one WebAssembly build of the kernel test under Node.js.
# Arguments: <folder with kerntest_occt.js and .wasm> <node report .json> <kerntest arguments...>
# Example: run-wasm.ps1 <out>\step <out>\node-step.json run --runs 5 --cases P1a,P3a --out <dir> --json <file>
# Plain $args is used on purpose (see run-windows.ps1).
$ErrorActionPreference = 'Stop'
if ($args.Count -lt 3) { throw 'usage: run-wasm.ps1 <build folder> <report.json> <kerntest arguments...>' }
$buildDir = $args[0]; $report = $args[1]; $ktArgs = @($args | Select-Object -Skip 2)
if (-not (Test-Path (Join-Path $buildDir 'kerntest_occt.wasm'))) { throw "kerntest_occt.wasm not found in $buildDir" }
$runner = Join-Path $PSScriptRoot '..\wasm\run-node.mjs'
node $runner $buildDir $report -- @ktArgs
exit $LASTEXITCODE
