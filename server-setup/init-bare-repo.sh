#!/usr/bin/env bash
# hermes bare repo 초기화.
#   1) ~/vault.git 를 bare repo(-b main)로 생성
#   2) main 에 union .gitattributes + .gitignore 초기 커밋
#   3) main 에 한해 non-fast-forward push 를 거절하는 pre-receive 훅 설치
#      (wip/* force-push 는 허용 — receive.denyNonFastForwards 는 전 ref 대상이라 쓰지 않는다)
#
# 사용:
#   hermes 에서 직접:  ./init-bare-repo.sh [REPO_PATH]
#   로컬에서 원격:     ssh ubuntu@<hermes> 'bash -s' -- < init-bare-repo.sh
#                      (원격 실행 시 vault.gitattributes/gitignore 를 같은 디렉토리에 함께 전송하거나
#                       아래 HEREDOC 폴백이 사용됨)
set -euo pipefail

REPO="${1:-$HOME/vault.git}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"

if [ -e "$REPO" ]; then
  echo "이미 존재: $REPO — 중단" >&2
  exit 1
fi

# 1) bare repo. 구버전 git(<2.28)은 -b 미지원 → symbolic-ref 폴백.
if ! git init --bare -b main "$REPO" 2>/dev/null; then
  git init --bare "$REPO"
  git -C "$REPO" symbolic-ref HEAD refs/heads/main
fi

# 2) 초기 커밋 (임시 워킹트리 경유)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone -q "$REPO" "$TMP"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/vault.gitattributes" ]; then
  cp "$SCRIPT_DIR/vault.gitattributes" "$TMP/.gitattributes"
  cp "$SCRIPT_DIR/vault.gitignore" "$TMP/.gitignore"
else
  # 원격 stdin 실행 폴백: 템플릿 인라인
  printf '*.md merge=union\n* text=auto eol=lf\n' > "$TMP/.gitattributes"
  printf '.obsidian/\n.DS_Store\nThumbs.db\n' > "$TMP/.gitignore"
fi

git -C "$TMP" add .gitattributes .gitignore
git -C "$TMP" -c user.name=setup -c user.email=setup@obsidian-git-sync.local \
  commit -q -m "init: union .gitattributes + .gitignore"
git -C "$TMP" push -q origin main

# 3) main non-ff 보호 훅
HOOK="$REPO/hooks/pre-receive"
cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
# refs/heads/main 은 fast-forward(=squash push)로만 전진 허용. wip/* 는 force 허용.
set -euo pipefail
while read -r oldrev newrev refname; do
  [ "$refname" = "refs/heads/main" ] || continue
  # 브랜치 최초 생성(oldrev 전부 0)은 허용
  case "$oldrev" in *[!0]*) : ;; *) continue ;; esac
  if [ "$(git merge-base "$oldrev" "$newrev")" != "$oldrev" ]; then
    echo "거절: main 은 fast-forward(저장/squash)로만 전진할 수 있습니다." >&2
    exit 1
  fi
done
HOOK_EOF
chmod +x "$HOOK"

echo "완료: $REPO"
echo "  - main 초기화 (union .gitattributes)"
echo "  - pre-receive: main non-ff 거절, wip/* force 허용"
echo "검증: git clone $REPO /tmp/verify && git -C /tmp/verify ls-remote --symref origin HEAD"
