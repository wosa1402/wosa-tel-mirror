#!/usr/bin/env bash
set -euo pipefail

REPO="${TG_BACK_REPO:-wosa1402/wosa-tel-mirror}"
INSTALL_DIR="${TG_BACK_INSTALL_DIR:-$HOME/tgback}"
KEEP_RELEASES="${TG_BACK_KEEP_RELEASES:-3}"
TAG="${TG_BACK_TAG:-}"
ENV_SOURCE="${TG_BACK_ENV_FILE:-}"
AUTO_MIGRATE=1
AUTO_START=1

usage() {
  cat <<'EOF'
一键部署 tgback 发布包

用法：
  bash scripts/deploy-release.sh [选项]

选项：
  --tag <tag>             部署指定版本，例如 v1.0.0
  --repo <owner/repo>     仓库，默认 wosa1402/wosa-tel-mirror
  --install-dir <dir>     安装目录，默认 $HOME/tgback
  --env-file <path>       指定现成的 .env 文件
  --keep <n>              最多保留多少个历史版本，默认 3
  --skip-migrate          跳过数据库迁移
  --skip-start            只部署，不启动
  --help                  显示帮助

示例：
  bash scripts/deploy-release.sh
  bash scripts/deploy-release.sh --tag v1.0.0
  bash scripts/deploy-release.sh --env-file /root/tgback.env --install-dir /opt/tgback
EOF
}

log() {
  printf '[tgback-deploy] %s\n' "$*"
}

die() {
  log "错误：$*"
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      [ $# -ge 2 ] || die "--tag 需要一个值"
      TAG="$2"
      shift 2
      ;;
    --repo)
      [ $# -ge 2 ] || die "--repo 需要一个值"
      REPO="$2"
      shift 2
      ;;
    --install-dir)
      [ $# -ge 2 ] || die "--install-dir 需要一个值"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --env-file)
      [ $# -ge 2 ] || die "--env-file 需要一个值"
      ENV_SOURCE="$2"
      shift 2
      ;;
    --keep)
      [ $# -ge 2 ] || die "--keep 需要一个值"
      KEEP_RELEASES="$2"
      shift 2
      ;;
    --skip-migrate)
      AUTO_MIGRATE=0
      shift
      ;;
    --skip-start)
      AUTO_START=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "不认识的参数：$1"
      ;;
  esac
done

case "$KEEP_RELEASES" in
  ''|*[!0-9]*)
    die "--keep 必须是正整数"
    ;;
esac

[ "$KEEP_RELEASES" -ge 1 ] || die "--keep 不能小于 1"

for cmd in curl tar grep sed find mktemp nohup; do
  need_cmd "$cmd"
done

GITHUB_API="https://api.github.com/repos/${REPO}"
RELEASES_DIR="${INSTALL_DIR}/releases"
SHARED_DIR="${INSTALL_DIR}/shared"
LOG_DIR="${INSTALL_DIR}/logs"
CURRENT_LINK="${INSTALL_DIR}/current"
PID_FILE="${INSTALL_DIR}/tgback.pid"
APP_LOG="${LOG_DIR}/tgback.log"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fetch_release_json() {
  if [ -n "$TAG" ]; then
    curl -fsSL "${GITHUB_API}/releases/tags/${TAG}"
  else
    curl -fsSL "${GITHUB_API}/releases/latest"
  fi
}

extract_string_field() {
  local key="$1"
  printf '%s\n' "$RELEASE_JSON" | sed -n "s/^[[:space:]]*\"${key}\":[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n1
}

stop_existing() {
  if [ ! -f "$PID_FILE" ]; then
    return 0
  fi

  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [ -z "$pid" ]; then
    rm -f "$PID_FILE"
    return 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    log "停止旧进程（PID ${pid}）"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      log "旧进程未正常退出，执行强制停止"
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  rm -f "$PID_FILE"
}

cleanup_old_releases() {
  local current_target
  current_target="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
  while IFS= read -r old_dir; do
    [ -n "$old_dir" ] || continue
    [ "$old_dir" = "$current_target" ] && continue
    rm -rf "$old_dir"
  done < <(
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
      | sort -rn \
      | awk -v keep="$KEEP_RELEASES" 'NR > keep { $1=""; sub(/^ /, ""); print }'
  )
}

RELEASE_JSON="$(fetch_release_json)"
RELEASE_TAG="$(extract_string_field tag_name)"
ASSET_URL="$(printf '%s\n' "$RELEASE_JSON" | sed -n 's/^[[:space:]]*"browser_download_url":[[:space:]]*"\([^"]*linux-x64\.tar\.gz\)".*/\1/p' | head -n1)"

[ -n "$RELEASE_TAG" ] || die "没有解析到版本标签"
[ -n "$ASSET_URL" ] || die "没有找到 Linux x64 发布包"

ASSET_NAME="${ASSET_URL##*/}"
DOWNLOAD_PATH="${TMP_DIR}/${ASSET_NAME}"
EXTRACT_ROOT="${TMP_DIR}/extract"

mkdir -p "$EXTRACT_ROOT" "$RELEASES_DIR" "$SHARED_DIR" "$LOG_DIR"

log "下载发布包：${ASSET_NAME}"
curl -fL "$ASSET_URL" -o "$DOWNLOAD_PATH"

log "解压发布包"
tar -xzf "$DOWNLOAD_PATH" -C "$EXTRACT_ROOT"

EXTRACTED_DIR="$(find "$EXTRACT_ROOT" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[ -n "$EXTRACTED_DIR" ] || die "发布包解压后没有找到目录"

RELEASE_DIR_NAME="$(basename "$EXTRACTED_DIR")"
TARGET_DIR="${RELEASES_DIR}/${RELEASE_DIR_NAME}"
SHARED_ENV="${SHARED_DIR}/.env"

if [ -n "$ENV_SOURCE" ]; then
  [ -f "$ENV_SOURCE" ] || die "指定的 env 文件不存在：$ENV_SOURCE"
  cp "$ENV_SOURCE" "$SHARED_ENV"
fi

if [ ! -f "$SHARED_ENV" ] && [ -L "$CURRENT_LINK" ] && [ -f "$CURRENT_LINK/.env" ]; then
  cp "$CURRENT_LINK/.env" "$SHARED_ENV"
fi

if [ ! -f "$SHARED_ENV" ]; then
  cp "$EXTRACTED_DIR/.env.example" "$SHARED_ENV"
  log "首次部署已生成示例配置：$SHARED_ENV"
  log "请先把 DATABASE_URL、ENCRYPTION_SECRET、TELEGRAM_API_ID、TELEGRAM_API_HASH 填好，再重新运行本脚本。"
  exit 2
fi

stop_existing

rm -rf "$TARGET_DIR"
mv "$EXTRACTED_DIR" "$TARGET_DIR"
cp "$SHARED_ENV" "$TARGET_DIR/.env"
ln -sfn "$TARGET_DIR" "$CURRENT_LINK"

if [ "$AUTO_MIGRATE" = "1" ]; then
  log "执行数据库迁移"
  (cd "$CURRENT_LINK" && ./migrate.sh)
fi

if [ "$AUTO_START" = "1" ]; then
  log "启动服务"
  nohup "$CURRENT_LINK/start-all.sh" >> "$APP_LOG" 2>&1 &
  echo "$!" > "$PID_FILE"
  sleep 2
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    die "启动失败，请检查日志：$APP_LOG"
  fi
fi

cleanup_old_releases

log "部署完成"
log "版本标签：$RELEASE_TAG"
log "当前目录：$CURRENT_LINK"
log "日志文件：$APP_LOG"
