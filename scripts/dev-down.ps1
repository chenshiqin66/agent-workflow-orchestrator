# 停止由 scripts/dev-up.ps1 启动的进程
$ErrorActionPreference = "Continue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pidsFile = Join-Path $Root ".logs\pids.txt"
if (-not (Test-Path $pidsFile)) {
  Write-Host "没有 .logs\pids.txt — 无需停止。"
  exit 0
}
Get-Content $pidsFile | ForEach-Object {
  $parts = $_ -split '\s+'
  if ($parts.Count -ge 2) {
    $oldPid = 0
    if ([int]::TryParse($parts[1], [ref]$oldPid)) {
      Write-Host "正在停止 $($parts[0]) pid=$oldPid"
      Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    }
  }
}
Remove-Item $pidsFile -Force -ErrorAction SilentlyContinue
Write-Host "完成。"
