#!/usr/bin/env bash
# gitvault-live 제거 (Linux / macOS)
#
#   플러그인:  ./uninstall.sh plugin --vault ~/Documents/my-vault
#   daemon:    ./uninstall.sh daemon  --name <name>            (또는 --vault <path> 로 이름 유추)
#
# curl 원격 실행(공개 repo):
#   curl -fsSL https://raw.githubusercontent.com/aprilslab/gitvault-live/main/uninstall.sh | bash -s -- plugin --vault ~/vault
#
# 플래그:
#   --vault  <path>   플러그인=Obsidian vault 폴더 / daemon=인스턴스 이름 유추용 (플러그인 모드 필수)
#   --name   <name>   daemon: 인스턴스 이름 (install 시 --name / vault 폴더명 slug 과 동일해야 함)
#
# [안전] vault 의 노트·`.git` 은 절대 건드리지 않는다. `.obsidian/plugins/gitvault-live/` 폴더와
#        해당 vault 용 백그라운드 데몬(launchd/systemd)만 제거한다. data.json(기기 설정·토큰)도 함께 삭제됨.
set -euo pipefail

MODE="${1:-}"; shift || true
VAULT=""; NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT="${2:-}"; shift 2 ;;
    --name)  NAME="${2:-}"; shift 2 ;;
    *) echo "알 수 없는 플래그: $1" >&2; exit 1 ;;
  esac
done

slug(){ printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-' | sed 's/^-*//;s/-*$//'; }
info(){ echo "→ $*"; }
die(){ echo "✗ $*" >&2; exit 1; }

case "$MODE" in plugin|daemon) ;; *) die "사용법: uninstall.sh [plugin|daemon] --vault <path> | --name <name>"; esac
OS="$(uname -s)"  # Linux / Darwin

# vault별 데몬 인스턴스 제거 — 사용자레벨(플러그인 자동설치)과 서버레벨(install.sh daemon) 모두 시도.
# 존재하지 않는 대상은 조용히 넘어간다(멱등).
remove_daemon(){
  name="$1"; [ -n "$name" ] || return 0
  if [ "$OS" = "Darwin" ]; then
    plist="$HOME/Library/LaunchAgents/com.gitvault-live.$name.plist"
    launchctl bootout "gui/$(id -u)/com.gitvault-live.$name" 2>/dev/null || true
    launchctl unload "$plist" 2>/dev/null || true
    [ -f "$plist" ] && rm -f "$plist" && info "제거: launchd $plist"
    rm -f "/tmp/ogs-daemon-$name.log" 2>/dev/null || true
  elif [ "$OS" = "Linux" ]; then
    systemctl --user disable --now "gitvault-live@$name" 2>/dev/null || true
    [ -f "$HOME/.config/gitvault-live/$name.env" ] && rm -f "$HOME/.config/gitvault-live/$name.env" && info "제거: ~/.config/gitvault-live/$name.env"
    # 서버(system) 인스턴스 — env 파일 있으면 sudo 로 중지·제거
    if [ -f "/etc/gitvault-live/$name.env" ] && command -v sudo >/dev/null 2>&1; then
      sudo systemctl disable --now "gitvault-live@$name" 2>/dev/null || true
      sudo rm -f "/etc/gitvault-live/$name.env" && info "제거: /etc/gitvault-live/$name.env (systemd gitvault-live@$name)"
    fi
  fi
}

# ── 플러그인 제거 ──────────────────────────────────────────────────────
if [ "$MODE" = "plugin" ]; then
  [ -n "$VAULT" ] || die "--vault <path> 필수"
  NAME="$(slug "$(basename "${VAULT%/}")")"
  DEST="$VAULT/.obsidian/plugins/gitvault-live"
  if [ -d "$DEST" ]; then
    rm -rf "$DEST"; info "제거: $DEST (main.js·manifest·styles·daemon.js·data.json)"
  else
    info "플러그인 폴더 없음(이미 제거됨): $DEST"
  fi
  remove_daemon "$NAME"  # 이 vault 용 자동설치 데몬도 정리
  echo "✓ 플러그인 제거 완료. vault 노트·.git 은 그대로입니다."
  echo "  Obsidian → 설정 → 커뮤니티 플러그인 목록에서 새로고침하면 사라집니다."
  exit 0
fi

# ── daemon 제거 ────────────────────────────────────────────────────────
NAME="${NAME:-$([ -n "$VAULT" ] && slug "$(basename "${VAULT%/}")" || true)}"
[ -n "$NAME" ] || die "daemon: --name <name> (또는 --vault <path>) 필수"
remove_daemon "$NAME"
echo "✓ daemon '$NAME' 제거 완료."
# 공유 산출물은 다른 인스턴스가 남아있을 수 있어 자동 삭제하지 않는다.
if [ "$OS" = "Linux" ] && [ -d /etc/gitvault-live ] && [ -z "$(ls -A /etc/gitvault-live 2>/dev/null)" ]; then
  echo "  남은 인스턴스 없음 — 공유 파일도 지우려면:"
  echo "    sudo rm -f /etc/systemd/system/gitvault-live@.service /opt/gitvault-live/daemon.js && sudo systemctl daemon-reload"
fi
