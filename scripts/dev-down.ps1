# Stop processes started by scripts/dev-up.ps1
$ErrorActionPreference = "Continue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pidsFile = Join-Path $Root ".logs\pids.txt"
if (-not (Test-Path $pidsFile)) {
  Write-Host "No .logs\pids.txt — nothing to stop."
  exit 0
}
Get-Content $pidsFile | ForEach-Object {
  $parts = $_ -split '\s+'
  if ($parts.Count -ge 2) {
    $oldPid = 0
    if ([int]::TryParse($parts[1], [ref]$oldPid)) {
      Write-Host "Stopping $($parts[0]) pid=$oldPid"
      Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    }
  }
}
Remove-Item $pidsFile -Force -ErrorAction SilentlyContinue
Write-Host "Done."
