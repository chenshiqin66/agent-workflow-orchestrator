# Windows 原生一键本地启动（PowerShell 5.1+ / 7+）。
# 依赖：Node ≥ 20、pnpm、Docker Desktop、Python ≥ 3.11
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\dev-up.ps1
# 有 WSL 时更推荐：bash scripts/dev-up.sh
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

$LogDir = Join-Path $Root ".logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not $env:DATABASE_URL) { $env:DATABASE_URL = "postgres://awo:awo@localhost:5432/awo" }
if (-not $env:EXECUTOR_TOKEN) { $env:EXECUTOR_TOKEN = "dev" }
if (-not $env:EXECUTOR_PORT) { $env:EXECUTOR_PORT = "8792" }
if (-not $env:EXECUTOR_URL) { $env:EXECUTOR_URL = "http://127.0.0.1:$($env:EXECUTOR_PORT)" }
if (-not $env:CALLBACK_BASE_URL) { $env:CALLBACK_BASE_URL = "http://127.0.0.1:8787" }
if (-not $env:PORT) { $env:PORT = "8787" }

function Die([string]$Msg) {
  Write-Host "错误: $Msg" -ForegroundColor Red
  exit 1
}

function Need-Cmd([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Die "缺少命令 '$Name'。请先安装后重试"
  }
}

Write-Host "==> 环境预检"
Need-Cmd "node"
Need-Cmd "pnpm"
Need-Cmd "docker"
$py = $null
foreach ($c in @("python", "python3", "py")) {
  if (Get-Command $c -ErrorAction SilentlyContinue) { $py = $c; break }
}
if (-not $py) { Die "缺少 Python ≥ 3.11" }

$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) {
  Die "需要 Node.js ≥ 20（当前 $(node -v)）"
}

$pyOk = & $py -c "import sys; print(1 if sys.version_info >= (3, 11) else 0)"
if (("" + $pyOk).Trim() -ne "1") {
  Die "需要 Python ≥ 3.11"
}

docker info 1>$null 2>$null
if ($LASTEXITCODE -ne 0) {
  Die "Docker 未运行。请启动 Docker Desktop 后重试。"
}

Write-Host "==> pnpm install"
pnpm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Postgres (docker compose)"
pnpm db:up
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> 等待 Postgres 就绪"
$pgReady = $false
for ($i = 1; $i -le 60; $i++) {
  docker compose exec -T postgres pg_isready -U awo -d awo 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) { $pgReady = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $pgReady) { Die "Postgres 在 60s 内未就绪" }

Write-Host "==> 迁移 + 种子数据"
pnpm --filter @awo/control-plane db:migrate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm --filter @awo/control-plane db:seed
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$venvDir = Join-Path $Root "apps\executor-py\.venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$venvPip = Join-Path $venvDir "Scripts\pip.exe"
$venvUvicorn = Join-Path $venvDir "Scripts\uvicorn.exe"
if (-not (Test-Path $venvUvicorn)) {
  Write-Host "==> Python 执行器虚拟环境"
  Push-Location (Join-Path $Root "apps\executor-py")
  & $py -m venv .venv
  & $venvPython -m pip install -U pip
  & $venvPip install -e ".[dev]"
  Pop-Location
} else {
  Write-Host "    .venv 已存在，跳过"
}

$webEnv = Join-Path $Root "apps\web\.env"
$webEnvExample = Join-Path $Root "apps\web\.env.example"
if (-not (Test-Path $webEnv)) {
  Write-Host "==> 从 .env.example 生成 apps/web/.env"
  Copy-Item $webEnvExample $webEnv
}

$pidsFile = Join-Path $LogDir "pids.txt"
if (Test-Path $pidsFile) {
  Write-Host "==> 停止此前的 dev-up 进程（若有）"
  Get-Content $pidsFile | ForEach-Object {
    $parts = $_ -split '\s+'
    if ($parts.Count -ge 2) {
      $oldPid = 0
      if ([int]::TryParse($parts[1], [ref]$oldPid)) {
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
      }
    }
  }
  Start-Sleep -Seconds 1
}

function Start-LoggedProcess {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [hashtable]$ExtraEnv
  )
  $stdout = Join-Path $LogDir "$Name.out.log"
  $stderr = Join-Path $LogDir "$Name.err.log"
  $old = @{}
  foreach ($k in $ExtraEnv.Keys) {
    $old[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
    [Environment]::SetEnvironmentVariable($k, $ExtraEnv[$k], "Process")
  }
  try {
    $p = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
      -WorkingDirectory $WorkingDirectory `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
      -PassThru -WindowStyle Hidden
  } finally {
    foreach ($k in $ExtraEnv.Keys) {
      [Environment]::SetEnvironmentVariable($k, $old[$k], "Process")
    }
  }
  return $p
}


function Resolve-Pnpm {
  if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) { return "pnpm.cmd" }
  if (Get-Command pnpm -ErrorAction SilentlyContinue) { return "pnpm" }
  Die "缺少 pnpm"
}
$PnpmExe = Resolve-Pnpm

Write-Host "==> 启动控制面 :$($env:PORT)"
$apiProc = Start-LoggedProcess -Name "api" -FilePath $PnpmExe -ArgumentList @("dev:api") `
  -WorkingDirectory $Root -ExtraEnv @{
    DATABASE_URL = $env:DATABASE_URL
    EXECUTOR_TOKEN = $env:EXECUTOR_TOKEN
    EXECUTOR_URL = $env:EXECUTOR_URL
    CALLBACK_BASE_URL = $env:CALLBACK_BASE_URL
    PORT = $env:PORT
  }

Write-Host "==> 启动执行器 :$($env:EXECUTOR_PORT)"
$execProc = Start-LoggedProcess -Name "executor" -FilePath $venvUvicorn -ArgumentList @(
  "awo_executor.main:app", "--app-dir", "src", "--host", "127.0.0.1", "--port", $env:EXECUTOR_PORT
) -WorkingDirectory (Join-Path $Root "apps\executor-py") -ExtraEnv @{
  EXECUTOR_TOKEN = $env:EXECUTOR_TOKEN
}

Write-Host "==> 启动 web :5173"
$webProc = Start-LoggedProcess -Name "web" -FilePath $PnpmExe -ArgumentList @("dev:web") `
  -WorkingDirectory $Root -ExtraEnv @{}

@(
  "api $($apiProc.Id)"
  "executor $($execProc.Id)"
  "web $($webProc.Id)"
) | Set-Content -Path $pidsFile -Encoding ascii

Write-Host ""
Write-Host "本地服务已就绪。"
Write-Host ""
Write-Host "  Web:      http://localhost:5173"
Write-Host "  API:      http://127.0.0.1:$($env:PORT)"
Write-Host "  执行器:   http://127.0.0.1:$($env:EXECUTOR_PORT)"
Write-Host ""
Write-Host "  PIDs: api=$($apiProc.Id) executor=$($execProc.Id) web=$($webProc.Id)"
Write-Host "  日志: $LogDir\*.out.log / *.err.log"
Write-Host "  停止:  powershell -ExecutionPolicy Bypass -File .\scripts\dev-down.ps1"
Write-Host ""
