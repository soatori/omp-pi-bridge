function Get-OmpAgentDir {
    param(
        [Parameter(Mandatory)]
        [string]$BaseDirectory,
        [AllowNull()]
        [AllowEmptyString()]
        [string]$ProfileName
    )

    $profileName = $ProfileName.Trim()
    $ompRoot = Join-Path $BaseDirectory ".omp"
    if (-not $profileName -or $profileName -eq "default") {
        return Join-Path $ompRoot "agent"
    }

    if ([IO.Path]::GetFileName($profileName) -cne $profileName -or $profileName -in @(".", "..")) {
        throw "Invalid OMP profile name: $profileName"
    }

    $profileRoot = Join-Path $ompRoot "profiles"
    $agentDir = [IO.Path]::GetFullPath((Join-Path (Join-Path $profileRoot $profileName) "agent"))
    $profilePrefix = [IO.Path]::GetFullPath($profileRoot).TrimEnd("\") + "\"
    if (-not $agentDir.StartsWith($profilePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "OMP profile path must stay under $profileRoot."
    }
    return $agentDir
}
