#!/usr/bin/env bash
# obsidian-git-sync 설치 (Linux / macOS)
#
#   플러그인:  ./install.sh plugin --vault ~/Documents/my-vault
#   daemon:    ./install.sh daemon --vault /srv/wiki --remote https://github.com/OWNER/REPO.git
#
# curl 원격 실행(공개 repo):
#   curl -fsSL https://raw.githubusercontent.com/aprilslab/obsidian-git-sync/main/install.sh | bash -s -- plugin --vault ~/vault
#
# 플래그:
#   --vault  <path>   플러그인=Obsidian vault 폴더 / daemon=감시할 vault 폴더 (필수)
#   --remote <url>    daemon: 대상 repo URL (origin 미설정 시). 토큰은 아래 --token 또는 git credential
#   --token  <tok>    daemon: 액세스 토큰(선택). 주면 remote URL 에 삽입. 생략 시 기존 git 자격증명 사용
#   --device <id>     daemon: 기기 식별자 (기본 hostname 기반)
#   --repo   <url>    소스 repo (기본 공개 repo). 로컬 clone 에서 실행 시 무시
set -euo pipefail

REPO_URL_DEFAULT="https://github.com/aprilslab/obsidian-git-sync.git"
MODE="${1:-}"; shift || true
VAULT=""; REMOTE=""; TOKEN=""; DEVICE=""; SRC_REPO="$REPO_URL_DEFAULT"

while [ $# -gt 0 ]; do
  case "$1" in
    --vault)  VAULT="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --token)  TOKEN="${2:-}"; shift 2 ;;
    --device) DEVICE="${2:-}"; shift 2 ;;
    --repo)   SRC_REPO="${2:-}"; shift 2 ;;
    *) echo "알 수 없는 플래그: $1" >&2; exit 1 ;;
  esac
done

die(){ echo "✗ $*" >&2; exit 1; }
info(){ echo "→ $*"; }
have(){ command -v "$1" >/dev/null 2>&1; }

case "$MODE" in plugin|daemon) ;; *) die "사용법: install.sh [plugin|daemon] --vault <path> [...]"; esac
have git  || die "git 필요"
have node || die "Node 18+ 필요 (node --version)"
have npm  || die "npm 필요"
[ -n "$VAULT" ] || die "--vault <path> 필수"

OS="$(uname -s)"  # Linux / Darwin

# ── 소스 확보: repo 안이면 그대로, 아니면 clone ──────────────────────────
if [ -f "package.json" ] && grep -q '"obsidian-git-sync"' package.json 2>/dev/null; then
  SRC="$(pwd)"
else
  SRC="${TMPDIR:-/tmp}/obsidian-git-sync-src"
  info "소스 clone: $SRC_REPO"
  rm -rf "$SRC"; git clone --depth 1 -q "$SRC_REPO" "$SRC"
fi
cd "$SRC"

info "의존성 설치 + 빌드"
npm install --silent
npm run build --silent

# ── 플러그인 설치 ──────────────────────────────────────────────────────
if [ "$MODE" = "plugin" ]; then
  DEST="$VAULT/.obsidian/plugins/obsidian-git-sync"
  [ -d "$VAULT/.obsidian" ] || die "vault 에 .obsidian 없음: $VAULT (Obsidian 으로 한 번 연 폴더인지 확인)"
  mkdir -p "$DEST"
  cp plugin/main.js plugin/manifest.json plugin/styles.css "$DEST/"
  echo "✓ 플러그인 설치됨: $DEST"
  echo "  다음: Obsidian → 설정 → 커뮤니티 플러그인 → 제한모드 해제 → obsidian-git-sync 활성화 → repo URL+토큰 입력 → [연결 테스트]"
  exit 0
fi

# ── daemon 설치 ────────────────────────────────────────────────────────
[ -f daemon/dist/index.js ] || die "daemon 빌드 산출물 없음"
DEVICE="${DEVICE:-$(hostname | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-')}"
# origin 미설정이면 --remote 필수. 토큰 주면 URL 에 삽입.
REMOTE_EFF="$REMOTE"
if [ -n "$TOKEN" ] && [ -n "$REMOTE" ]; then
  REMOTE_EFF="$(printf '%s' "$REMOTE" | sed -E "s#^https://#https://${TOKEN}@#")"
fi
if [ -z "$REMOTE_EFF" ]; then
  if git -C "$VAULT" remote get-url origin >/dev/null 2>&1; then
    REMOTE_EFF="$(git -C "$VAULT" remote get-url origin)"  # 기존 origin + git 자격증명 재사용
    info "기존 origin 재사용 (토큰 미삽입 — git credential 사용)"
  else
    die "daemon: --remote <url> 필수 (vault 에 origin 도 없음)"
  fi
fi

sudo mkdir -p /opt/obsidian-git-sync /etc/obsidian-git-sync
sudo cp daemon/dist/index.js /opt/obsidian-git-sync/daemon.js
ENVF="/etc/obsidian-git-sync/daemon.env"
sudo tee "$ENVF" >/dev/null <<ENV
VAULT_PATH=$VAULT
REMOTE=$REMOTE_EFF
DEVICE_ID=$DEVICE
DEBOUNCE_MS=3000
ENV
sudo chmod 600 "$ENVF"

if [ "$OS" = "Linux" ]; then
  have systemctl || die "systemd 없음 — 수동 실행: VAULT_PATH=$VAULT REMOTE=... node /opt/obsidian-git-sync/daemon.js"
  sudo tee /etc/systemd/system/obsidian-git-sync.service >/dev/null <<UNIT
[Unit]
Description=obsidian-git-sync daemon ($VAULT)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
Environment=HOME=$HOME
EnvironmentFile=$ENVF
ExecStart=$(command -v node) /opt/obsidian-git-sync/daemon.js
Restart=always
RestartSec=5
User=$(id -un)
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now obsidian-git-sync
  echo "✓ daemon 상주 시작 (systemd)"
  echo "  로그: journalctl -u obsidian-git-sync -f   중지: sudo systemctl disable --now obsidian-git-sync"
elif [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.obsidian-git-sync.daemon.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.obsidian-git-sync.daemon</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v node)</string><string>/opt/obsidian-git-sync/daemon.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>VAULT_PATH</key><string>$VAULT</string>
    <key>REMOTE</key><string>$REMOTE_EFF</string>
    <key>DEVICE_ID</key><string>$DEVICE</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/ogs-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/ogs-daemon.log</string>
</dict></plist>
PL
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "✓ daemon 상주 시작 (launchd)"
  echo "  로그: tail -f /tmp/ogs-daemon.log   중지: launchctl unload $PLIST"
else
  die "미지원 OS: $OS (Windows 는 install.ps1)"
fi
