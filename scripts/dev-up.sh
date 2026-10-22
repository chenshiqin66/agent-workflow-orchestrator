#!/usr/bin/env bash
# 一键本地启动：安装依赖 → Postgres → migrate/seed → API + 执行器 + web。
# 用法（在仓库根目录）：
#   bash scripts/dev-up.sh
#   pnpm dev:up
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/.logs"
mkdir -p "$LOG_DIR"

DATABASE_URL="${DATABASE_URL:-postgres://awo:awo@localhost:5432/awo}"
EXECUTOR_TOKEN="${EXECUTOR_TOKEN:-dev}"
EXECUTOR_PORT="${EXECUTOR_PORT:-8792}"
EXECUTOR_URL="${EXECUTOR_URL:-http://127.0.0.1:${EXECUTOR_PORT}}"
CALLBACK_BASE_URL="${CALLBACK_BASE_URL:-http://127.0.0.1:8787}"
PORT="${PORT:-8787}"

die() {
  echo "错误: $*" >&2
  exit 1
}

need_cmd() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "缺少命令 '$name'。请先安装后重试"
}

http_ok() {
  local url="$1"
  curl -fsS -o /dev/null --connect-timeout 1 "$url" 2>/dev/null
}

echo "==> 环境预检"
need_cmd node
need_cmd pnpm
need_cmd docker
need_cmd python3
need_cmd curl

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "需要 Node.js ≥ 20（当前 $(node -v)）"
fi

PY_OK="$(python3 - <<'PY'
import sys
print(1 if sys.version_info >= (3, 11) else 0)
PY
)"
if [[ "$PY_OK" != "1" ]]; then
  die "需要 Python ≥ 3.11（当前 $(python3 -V)）"
fi

if ! docker info >/dev/null 2>&1; then
  die "Docker 未运行或当前用户无权访问。请启动 Docker Desktop / daemon 后重试。"
fi

echo "    node $(node -v), pnpm $(pnpm -v), $(python3 -V), docker ok"

echo "==> pnpm install"
pnpm install

echo "==> Postgres (docker compose)"
pnpm db:up

echo "==> 等待 Postgres 就绪"
for i in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U awo -d awo >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    die "Postgres 在 60s 内未就绪"
  fi
  sleep 1
done

export DATABASE_URL EXECUTOR_TOKEN EXECUTOR_URL CALLBACK_BASE_URL PORT

echo "==> 迁移 + 种子数据"
pnpm --filter @awo/control-plane db:migrate
pnpm --filter @awo/control-plane db:seed

echo "==> Python 执行器虚拟环境"
if [[ ! -x "$ROOT/apps/executor-py/.venv/bin/uvicorn" ]]; then
  (
    cd "$ROOT/apps/executor-py"
    python3 -m venv .venv
    .venv/bin/pip install -U pip
    .venv/bin/pip install -e ".[dev]"
  )
else
  echo "    .venv 已存在，跳过"
fi

if [[ ! -f "$ROOT/apps/web/.env" ]]; then
  echo "==> 从 .env.example 生成 apps/web/.env"
  cp "$ROOT/apps/web/.env.example" "$ROOT/apps/web/.env"
elif ! grep -q '^VITE_API_BASE=' "$ROOT/apps/web/.env" 2>/dev/null; then
  echo "VITE_API_BASE=http://localhost:8787" >> "$ROOT/apps/web/.env"
fi

if [[ -f "$LOG_DIR/pids.txt" ]]; then
  echo "==> 停止此前的 dev-up 进程（若有）"
  while read -r _name old_pid; do
    if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null || true
    fi
  done < "$LOG_DIR/pids.txt" || true
  sleep 1
fi

echo "==> 启动控制面 :${PORT}"
(
  export DATABASE_URL EXECUTOR_TOKEN EXECUTOR_URL CALLBACK_BASE_URL PORT
  nohup pnpm dev:api >"$LOG_DIR/api.log" 2>&1 &
  echo $! >"$LOG_DIR/api.pid"
)

echo "==> 启动执行器 :${EXECUTOR_PORT}"
(
  cd "$ROOT/apps/executor-py"
  export EXECUTOR_TOKEN
  nohup .venv/bin/uvicorn awo_executor.main:app --app-dir src --host 127.0.0.1 --port "$EXECUTOR_PORT" \
    >"$LOG_DIR/executor.log" 2>&1 &
  echo $! >"$LOG_DIR/executor.pid"
)

echo "==> 启动 web :5173"
(
  nohup pnpm dev:web >"$LOG_DIR/web.log" 2>&1 &
  echo $! >"$LOG_DIR/web.pid"
)

API_PID="$(cat "$LOG_DIR/api.pid")"
EXEC_PID="$(cat "$LOG_DIR/executor.pid")"
WEB_PID="$(cat "$LOG_DIR/web.pid")"
{
  echo "api $API_PID"
  echo "executor $EXEC_PID"
  echo "web $WEB_PID"
} >"$LOG_DIR/pids.txt"

echo "==> 等待 HTTP 就绪"
api_ok=0
exec_ok=0
web_ok=0
for i in $(seq 1 90); do
  if [[ "$api_ok" -eq 0 ]] && http_ok "http://127.0.0.1:${PORT}/health"; then
    api_ok=1
  fi
  if [[ "$exec_ok" -eq 0 ]] && http_ok "http://127.0.0.1:${EXECUTOR_PORT}/health"; then
    exec_ok=1
  fi
  if [[ "$web_ok" -eq 0 ]] && http_ok "http://127.0.0.1:5173/"; then
    web_ok=1
  fi
  if [[ "$api_ok" -eq 1 && "$exec_ok" -eq 1 && "$web_ok" -eq 1 ]]; then
    break
  fi
  if [[ "$i" -eq 90 ]]; then
    echo "警告: 部分服务可能尚未就绪，请查看 .logs/*.log (api=$api_ok executor=$exec_ok web=$web_ok)" >&2
  fi
  sleep 1
done

cat <<OUT

本地服务已就绪。

  Web:      http://localhost:5173
  API:      http://127.0.0.1:${PORT}
  执行器:   http://127.0.0.1:${EXECUTOR_PORT}

  PIDs: api=${API_PID} executor=${EXEC_PID} web=${WEB_PID}
  日志: ${LOG_DIR}/api.log ${LOG_DIR}/executor.log ${LOG_DIR}/web.log
  停止: kill \$(awk '{print \$2}' ${LOG_DIR}/pids.txt)

OUT
