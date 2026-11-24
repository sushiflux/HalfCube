# Helpers shared by the Docker scripts of the kernel test.

function Assert-FreeSpace([int]$MinFreeGB) {
    # Docker Desktop keeps its data on the system drive.
    $drive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))
    $freeGB = [math]::Round($drive.Free / 1GB, 1)
    if ($freeGB -lt $MinFreeGB) { throw "Only $freeGB GB free on $($env:SystemDrive); at least $MinFreeGB GB required." }
    Write-Host "free on $($env:SystemDrive): $freeGB GB"
}

function Remove-KtContainer([string]$Name) {
    $id = docker ps -aq --filter "name=^${Name}$"
    if ($id) { docker rm -f $Name | Out-Null }
}

function Copy-IntoContainer([string]$Container, [string]$HostDir, [string]$Target) {
    if (-not (Test-Path $HostDir)) { throw "missing: $HostDir" }
    docker exec $Container mkdir -p (Split-Path $Target -Parent).Replace('\', '/') | Out-Null
    docker cp "$HostDir" "${Container}:$Target"
    if ($LASTEXITCODE -ne 0) { throw "docker cp failed for $HostDir" }
}

# Copies the test sources and converts the shell scripts to LF line endings inside the container.
function Copy-KtSources([string]$Container, [string]$HostDir, [string]$Target) {
    Copy-IntoContainer $Container $HostDir $Target
    docker exec $Container sh -c "find $Target -name '*.sh' -exec sed -i 's/\r$//' {} +"
}
