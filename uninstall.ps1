[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [AllowNull()]
    [Alias("Profile")]
    [string]$OmpProfile = $env:OMP_PROFILE
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\omp-profile-path.ps1")

$agentDir = Get-OmpAgentDir -BaseDirectory $env:USERPROFILE -ProfileName $OmpProfile
$extensionsDir = [IO.Path]::GetFullPath((Join-Path $agentDir "extensions"))
$extensionDir = [IO.Path]::GetFullPath((Join-Path $extensionsDir "omp-pi-bridge"))
$extensionsPrefix = $extensionsDir.TrimEnd("\") + "\"
if (-not $extensionDir.StartsWith($extensionsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Uninstall target must stay under $extensionsDir."
}

if (-not (Test-Path -LiteralPath $extensionDir)) {
    Write-Output "OMP Pi Bridge is not installed for this profile."
    return
}

$item = Get-Item -LiteralPath $extensionDir -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to remove a linked extension directory: $extensionDir"
}

if ($PSCmdlet.ShouldProcess($extensionDir, "Remove OMP Pi Bridge extension")) {
    Remove-Item -LiteralPath $extensionDir -Recurse -Force
    Write-Output "Removed OMP Pi Bridge extension from $extensionDir"
    Write-Output "Pi session files, OMP state, and shared Bun/OMP PATH entries were preserved."
}
