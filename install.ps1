param(
    [AllowNull()]
    [Alias("Profile")]
    [string]$OmpProfile = $env:OMP_PROFILE
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "scripts\omp-profile-path.ps1")

$sourceDir = Join-Path $PSScriptRoot "src"
$agentDir = Get-OmpAgentDir -BaseDirectory $env:USERPROFILE -ProfileName $OmpProfile
$extensionDir = Join-Path $agentDir "extensions\omp-pi-bridge"

if (-not (Test-Path (Join-Path $sourceDir "index.ts"))) {
    throw "Extension source not found under $sourceDir"
}

New-Item -ItemType Directory -Path $extensionDir -Force | Out-Null
Get-ChildItem -LiteralPath $sourceDir -Force | Copy-Item -Destination $extensionDir -Recurse -Force

$requiredPaths = @(
    (Join-Path $env:USERPROFILE ".bun\bin"),
    (Join-Path $env:APPDATA "npm\node_modules\bun\bin")
) | Where-Object { Test-Path $_ }
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathParts = [System.Collections.Generic.List[string]]::new()
if ($userPath) {
    foreach ($part in ($userPath -split ";")) {
        $trimmed = $part.Trim()
        if ($trimmed -and -not $pathParts.Contains($trimmed)) { $pathParts.Add($trimmed) }
    }
}
foreach ($requiredPath in $requiredPaths) {
    if (-not ($pathParts | Where-Object { [string]::Equals($_, $requiredPath, [System.StringComparison]::OrdinalIgnoreCase) })) {
        $pathParts.Add($requiredPath)
    }
}
[Environment]::SetEnvironmentVariable("Path", [string]::Join(";", $pathParts), "User")

Write-Output "Installed OMP extension to $extensionDir"
Write-Output "Updated the user PATH for omp and Bun where needed. Open a new PowerShell window before running omp."
