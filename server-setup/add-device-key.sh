#!/usr/bin/env bash
# 기기 공개키를 hermes authorized_keys 에 git 전용 제한 옵션으로 등록.
# 플러그인 "연결 설정" 위저드가 출력한 공개키 한 줄을 관리자가 이 스크립트로 등록한다.
#
# 사용: ./add-device-key.sh "ssh-ed25519 AAAA...키... ogs-<deviceId>" [authorized_keys_path]
set -euo pipefail

KEY="${1:?사용법: add-device-key.sh \"<공개키 한 줄>\" [authorized_keys 경로]}"
AUTH="${2:-$HOME/.ssh/authorized_keys}"
OPTS='no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding'

mkdir -p "$(dirname "$AUTH")"
chmod 700 "$(dirname "$AUTH")"
touch "$AUTH"
chmod 600 "$AUTH"

# 키 본문(2번째 필드)으로 중복 검사
BODY="$(printf '%s' "$KEY" | awk '{print $2}')"
if [ -n "$BODY" ] && grep -qF "$BODY" "$AUTH"; then
  echo "이미 등록된 키 — 건너뜀" >&2
  exit 0
fi

printf '%s %s\n' "$OPTS" "$KEY" >> "$AUTH"
echo "등록 완료 (git 전용 제한: $OPTS)"
