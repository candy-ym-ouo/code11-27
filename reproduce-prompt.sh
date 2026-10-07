#!/usr/bin/env bash
# 提示词复现入口：先把「成员打开首页看最近更新」所需的数据准备好（真实 HTTP + 真实上传 + 真实缩略图），
# 再由录制器的浏览器验证脚本登录成员、打开首页检查 6 张缩略图是否真的解码出来，
# 并在 access token 过期后重新请求，检查能否自动恢复。
set -euo pipefail
cd "$(dirname "$0")"
export TZ=Asia/Shanghai
export AB_STATE_DIR="${AB_STATE_DIR:-$HOME/.cache/code11-27-b}"

# 录制器可能先读到上一轮的状态文件：等本轮启动器写出 api-url 再开跑。
for _ in $(seq 1 240); do [ -s "$AB_STATE_DIR/api-url" ] && break; sleep 0.5; done
[ -s "$AB_STATE_DIR/api-url" ] || { echo "等待 $AB_STATE_DIR/api-url 超时" >&2; exit 1; }

export API_BASE_URL="${API_BASE_URL:-$(cat "$AB_STATE_DIR/api-url")}"
echo "[复现] API：$API_BASE_URL"
echo "[复现] 夹具：$AB_STATE_DIR"

node scripts/ab-seed-home.mjs
