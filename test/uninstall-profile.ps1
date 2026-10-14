$ErrorActionPreference = "Stop"

$repoTempRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\temp"))
$testRoot = Join-Path $repoTempRoot "uninstall-profile-$([guid]::NewGuid().ToString('N'))"
$resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
$prefix = $repoTempRoot.TrimEnd("\") + "\"
if (-not $resolvedTestRoot.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Test directory escaped the project temp directory."
}

$previousUserProfile = $env:USERPROFILE
$previousOmpProfile = $env:OMP_PROFILE
try {
    $env:USERPROFILE = $resolvedTestRoot
    $env:OMP_PROFILE = ""
    $agentDir = Join-Path $resolvedTestRoot ".omp\profiles\work\agent"
    $extensionDir = Join-Path $agentDir "extensions\omp-pi-bridge"
    $stateFile = Join-Path $agentDir "omp-pi-bridge-state.json"
    $piSessionFile = Join-Path $resolvedTestRoot ".pi\agent\sessions\keep.jsonl"
    New-Item -ItemType Directory -Path $extensionDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $piSessionFile) -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $extensionDir "index.ts") -Value "test extension"
    Set-Content -LiteralPath $stateFile -Value "test state"
    Set-Content -LiteralPath $piSessionFile -Value "test Pi session"

    & (Join-Path $PSScriptRoot "..\uninstall.ps1") -Profile "work"

    if (Test-Path -LiteralPath $extensionDir) { throw "The extension directory still exists after uninstall." }
    if (-not (Test-Path -LiteralPath $stateFile)) { throw "Uninstall removed bridge state." }
    if (-not (Test-Path -LiteralPath $piSessionFile)) { throw "Uninstall removed Pi session data." }
} finally {
    $env:USERPROFILE = $previousUserProfile
    $env:OMP_PROFILE = $previousOmpProfile
    if (Test-Path -LiteralPath $resolvedTestRoot) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
