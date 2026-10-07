#!/usr/bin/env bash
# ab-record 本地录制启动器（无容器、无桌面窗口）：
#   1. 在 $AB_STATE_DIR 下自建独立 PostgreSQL 集群，不碰工作区 data/ 与系统服务；
#   2. 源码比上次构建新时才重新构建 shared/api/web；
#   3. 每次启动重建一个干净的录制数据库并跑迁移，保证复现可重复；
#   4. 启动 API（内部端口）与录制网关（对外端口，/health 直接回 200，其余反代到 API）；
#   5. 写出 api-url / web-url / database-url / jwt-secret，收到退出信号时回收自己启动的进程。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

STATE_DIR="${AB_STATE_DIR:-$HOME/.cache/code11-27-a}"
PG_USER_NAME="${AB_PG_USER:-heirloom}"
PG_PASS="${AB_PG_PASSWORD:-change-me-please}"
PG_DB="${AB_PG_DB:-heirloom_record}"
PGDATA_DIR="$STATE_DIR/pgdata"
PG_SOCKET_DIR="$STATE_DIR/pg-socket"
PG_LOG="$STATE_DIR/postgres.log"
API_LOG="$STATE_DIR/api.log"
GATEWAY_LOG="$STATE_DIR/gateway.log"
BUILD_STAMP="$STATE_DIR/build-stamp"
PG_PORT_FILE="$STATE_DIR/pg-port"
PUBLIC_PORT_FILE="$STATE_DIR/api-port"
INTERNAL_PORT_FILE="$STATE_DIR/api-internal-port"

mkdir -p "$STATE_DIR" "$PG_SOCKET_DIR"
# 清掉上一次运行留下的状态与夹具：录制器会读 api-url/web-url，残留文件会让它抢跑。
rm -f "$STATE_DIR/api-url" "$STATE_DIR/web-url" "$STATE_DIR/database-url" "$STATE_DIR/jwt-secret" "$STATE_DIR/fixture.json"

log() { printf '[start-local] %s\n' "$*"; }

port_free() {
  node -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.once("listening", () => server.close(() => process.exit(0)));
    server.listen(port);
  ' "$1" >/dev/null 2>&1
}

pick_port() {
  local port="$1"
  while ! port_free "$port"; do port=$((port + 1)); done
  printf '%s' "$port"
}

resolve_port() {
  local file="$1" base="$2" port=""
  if [ -f "$file" ]; then port="$(cat "$file" 2>/dev/null || true)"; fi
  if [ -z "$port" ] || ! port_free "$port"; then
    port="$(pick_port "$base")"
    printf '%s' "$port" > "$file"
  fi
  printf '%s' "$port"
}

command -v initdb >/dev/null 2>&1 || { log "找不到 initdb，请先安装 PostgreSQL"; exit 1; }
command -v node >/dev/null 2>&1 || { log "找不到 node"; exit 1; }

# 本机 pnpm shim 指向 nvmd，这里直接用已安装的 pnpm 9.12.0，避免 shim 改写退出码。
PNPM_REAL="$(node -e '
  const { existsSync } = require("node:fs");
  const candidates = [
    process.env.AB_PNPM_PATH,
    "/Users/a1-6/.nvmd/versions/25.0.0/lib/node_modules/pnpm/bin/pnpm.cjs",
    "/Users/a1-6/.nvmd/versions/22.14.0/lib/node_modules/pnpm/bin/pnpm.cjs",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  process.stdout.write(found ?? "");
')"
if [ -n "$PNPM_REAL" ]; then
  PNPM_BIN_DIR="$STATE_DIR/bin"
  mkdir -p "$PNPM_BIN_DIR"
  printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$PNPM_REAL" > "$PNPM_BIN_DIR/pnpm"
  chmod +x "$PNPM_BIN_DIR/pnpm"
  export PATH="$PNPM_BIN_DIR:$PATH"
  log "使用 pnpm：$PNPM_REAL"
fi

# ---------- 数据库 ----------
mkdir -p "$PG_SOCKET_DIR"
if [ ! -f "$PGDATA_DIR/PG_VERSION" ]; then
  log "初始化独立 PostgreSQL 集群：$PGDATA_DIR"
  pwfile="$(mktemp)"
  printf '%s' "$PG_PASS" > "$pwfile"
  initdb -D "$PGDATA_DIR" -U "$PG_USER_NAME" --pwfile="$pwfile" \
    --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C >/dev/null
  rm -f "$pwfile"
fi

start_postgres() {
  PGPORT="$(resolve_port "$PG_PORT_FILE" 55628)"
  log "启动 PostgreSQL（端口 $PGPORT）"
  pg_ctl -D "$PGDATA_DIR" -l "$PG_LOG" \
    -o "-p $PGPORT -k $PG_SOCKET_DIR -h 127.0.0.1" -w start >/dev/null
}

if pg_ctl -D "$PGDATA_DIR" status >/dev/null 2>&1; then
  RUNNING_PORT="$(sed -n '4p' "$PGDATA_DIR/postmaster.pid" 2>/dev/null || true)"
  pg_ready=0
  for _ in $(seq 1 40); do
    if [ -n "$RUNNING_PORT" ] && pg_isready -h 127.0.0.1 -p "$RUNNING_PORT" -q; then pg_ready=1; break; fi
    sleep 0.25
  done
  if [ "$pg_ready" = "1" ]; then
    PGPORT="$RUNNING_PORT"
    log "复用已运行的 PostgreSQL（端口 $PGPORT）"
  else
    log "检测到残留的 PostgreSQL 状态，等待旧实例退出"
    for _ in $(seq 1 60); do pg_ctl -D "$PGDATA_DIR" status >/dev/null 2>&1 || break; sleep 0.25; done
    if pg_ctl -D "$PGDATA_DIR" status >/dev/null 2>&1; then
      pg_ctl -D "$PGDATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
    fi
    start_postgres
  fi
else
  start_postgres
fi
[ -n "${PGPORT:-}" ] || { log "PostgreSQL 端口未知"; exit 1; }

export PGPASSWORD="$PG_PASS"
dropdb --if-exists --force -h 127.0.0.1 -p "$PGPORT" -U "$PG_USER_NAME" "$PG_DB" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  if createdb -h 127.0.0.1 -p "$PGPORT" -U "$PG_USER_NAME" "$PG_DB" 2>/dev/null; then break; fi
  sleep 0.5
done
psql -h 127.0.0.1 -p "$PGPORT" -U "$PG_USER_NAME" -d "$PG_DB" -tAc 'select 1' >/dev/null
log "已重建录制数据库 $PG_DB"

# ---------- 应用环境 ----------
PUBLIC_PORT="$(resolve_port "$PUBLIC_PORT_FILE" 45528)"
INTERNAL_PORT="$(resolve_port "$INTERNAL_PORT_FILE" 46128)"
export DATABASE_URL="postgresql://$PG_USER_NAME:$PG_PASS@127.0.0.1:$PGPORT/$PG_DB?schema=public"
export NODE_ENV=production
export APP_NAME='家中物品来历册'
export APP_URL="http://127.0.0.1:$PUBLIC_PORT"
export API_PORT="$INTERNAL_PORT"
export SERVE_WEB=true
export WEB_DIST=./apps/web/dist
export STORAGE_ROOT="$STATE_DIR/uploads"
export EXPORT_ROOT="$STATE_DIR/exports"
export BACKUP_ROOT="$STATE_DIR/backups"
export JWT_SECRET="${JWT_SECRET:-$(cat "$STATE_DIR/jwt-secret" 2>/dev/null || openssl rand -hex 32)}"
printf '%s' "$JWT_SECRET" > "$STATE_DIR/jwt-secret"
export COOKIE_SECURE=false
export LOG_LEVEL=info
# 录制复现用短有效期：让「令牌过期后自动恢复」在 90 秒视频内真实可见（仅本地录制配置）。
export ACCESS_TOKEN_TTL="${ACCESS_TOKEN_TTL:-10s}"
export WORKER_ENABLED=true
export WORKER_POLL_MS=1000
export PUBLIC_SIGNUP=true
export TZ=Asia/Shanghai

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  log "安装依赖（pnpm install）"
  CI=1 NODE_ENV=development pnpm install --prefer-offline --store-dir "$STATE_DIR/pnpm-store"
fi

# ---------- 构建（源码未变化时跳过） ----------
needs_build() {
  [ -f "$BUILD_STAMP" ] || return 0
  [ -f "packages/shared/dist/index.js" ] || return 0
  [ -f "apps/api/dist/index.js" ] || return 0
  [ -f "apps/web/dist/index.html" ] || return 0
  if find apps packages \
    \( -path '*/node_modules' -o -path '*/dist' \) -prune -o \
    -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.prisma' -o -name '*.sql' -o -name '*.css' -o -name '*.html' \) \
    -newer "$BUILD_STAMP" -print -quit | grep -q .; then
    return 0
  fi
  return 1
}

if needs_build; then
  log "构建 @heirloom/shared、@heirloom/api、@heirloom/web"
  pnpm --filter @heirloom/shared build
  pnpm --filter @heirloom/api exec prisma generate
  pnpm --filter @heirloom/api build
  pnpm --filter @heirloom/web build
  touch "$BUILD_STAMP"
else
  log "复用已有构建产物（源码未变化）"
  pnpm --filter @heirloom/api exec prisma generate >/dev/null
fi

log "应用数据库迁移"
pnpm --filter @heirloom/api exec prisma migrate deploy >/dev/null

# ---------- 启动 API（内部端口） ----------
API_LAUNCHER="$STATE_DIR/run-api.mjs"
printf 'import(%s);\n' "'file://$ROOT_DIR/apps/api/dist/index.js'" > "$API_LAUNCHER"

API_PID=""
GATEWAY_PID=""
SHUTTING_DOWN=0
cleanup() {
  trap - EXIT INT TERM
  SHUTTING_DOWN=1
  for pid in "${GATEWAY_PID:-}" "${API_PID:-}"; do
    [ -n "$pid" ] || continue
    if kill -0 "$pid" 2>/dev/null; then
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      pkill -P "$pid" 2>/dev/null || true
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  pg_ctl -D "$PGDATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
  log "已停止 API、录制网关与本地数据库"
}
trap cleanup EXIT INT TERM

start_api() {
  node "$API_LAUNCHER" >>"$API_LOG" 2>&1 &
  API_PID=$!
}

start_gateway() {
  node "$STATE_DIR/gateway.mjs" "$PUBLIC_PORT" "$INTERNAL_PORT" >>"$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID=$!
}

wait_api_ready() {
  local ready=0
  for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:$INTERNAL_PORT/readyz" >/dev/null 2>&1; then ready=1; break; fi
    if ! kill -0 "$API_PID" 2>/dev/null; then
      log "API 进程退出，日志尾部："
      tail -n 30 "$API_LOG" || true
      return 1
    fi
    sleep 0.5
  done
  if [ "$ready" != "1" ]; then
    log "等待 API 就绪超时，日志尾部："
    tail -n 30 "$API_LOG" || true
    return 1
  fi
  return 0
}

write_gateway() {
  cat > "$STATE_DIR/gateway.mjs" <<'EOF'
import http from "node:http";

const publicPort = Number(process.argv[2]);
const apiPort = Number(process.argv[3]);

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/health/ready" || req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  const headers = { ...req.headers, host: `127.0.0.1:${apiPort}` };
  const upstream = http.request(
    { host: "127.0.0.1", port: apiPort, path: req.url, method: req.method, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("bad gateway");
  });
  req.pipe(upstream);
});

server.listen(publicPort, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
EOF
}

start_api
wait_api_ready || exit 1
write_gateway
start_gateway

BASE_URL="http://127.0.0.1:$PUBLIC_PORT"
gateway_ready=0
for _ in $(seq 1 60); do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then gateway_ready=1; break; fi
  sleep 0.5
done
if [ "$gateway_ready" != "1" ]; then
  log "录制网关未就绪，日志尾部："
  tail -n 20 "$GATEWAY_LOG" || true
  exit 1
fi

printf 'http://127.0.0.1:%s' "$PUBLIC_PORT" > "$STATE_DIR/api-url"
printf 'http://127.0.0.1:%s' "$PUBLIC_PORT" > "$STATE_DIR/web-url"
printf 'postgresql://%s:%s@127.0.0.1:%s/%s' "$PG_USER_NAME" "$PG_PASS" "$PGPORT" "$PG_DB" > "$STATE_DIR/database-url"
log "就绪：API 与 Web 均运行在 $BASE_URL（内部 API 端口 $INTERNAL_PORT）"

# 外部脚本误杀 API 时自动拉起，保证录制期间服务不中断。
while [ "$SHUTTING_DOWN" = "0" ]; do
  code=0
  wait "$API_PID" || code=$?
  [ "$SHUTTING_DOWN" = "1" ] && break
  log "API 进程意外退出（code=$code），自动重启"
  sleep 1
  start_api
  wait_api_ready || exit 1
done
