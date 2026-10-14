$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "..\scripts\omp-profile-path.ps1")

$testHome = "C:\fixture\home"
$default = Get-OmpAgentDir -BaseDirectory $testHome -ProfileName $null
$named = Get-OmpAgentDir -BaseDirectory $testHome -ProfileName "work"
if ($default -ne (Join-Path $testHome ".omp\agent")) { throw "Default profile path is incorrect: $default" }
if ($named -ne (Join-Path $testHome ".omp\profiles\work\agent")) { throw "Named profile path is incorrect: $named" }

try {
    Get-OmpAgentDir -BaseDirectory $testHome -ProfileName "..\outside" | Out-Null
} catch {
    exit 0
}
throw "A path-traversing profile name was accepted."
