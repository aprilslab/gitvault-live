# daemon 배포 — 개인 서버 → 로컬 Obsidian bridge

서버에서 파일이 바뀌면(에이전트·cron·vim·타 서비스 무관) daemon 이 감지→커밋→`origin/main` push,
로컬 Obsidian 플러그인이 주기(pull, 기본 5초) sync-down 으로 반영한다. 반대 방향도 동일하게 동작
(daemon 이 60초마다 sync-down → 서버 워킹트리에 로컬 편집분 병합).

체감 지연: 서버 저장 → Obsidian 표시 ≈ `DEBOUNCE_MS`(3s) + push + 플러그인 pull 주기(5s) ≈ 10초 내외.

## 요구사항 (서버)

- Linux, Node 18+, git CLI
- vault 디렉터리 쓰기 권한 (기존 파일 있어도 됨 — 첫 기동 시 adopt 온보딩이 로컬·원격 양쪽 보존)

## 절차

```bash
# 1. 로컬에서 빌드 (단일 파일 번들)
npm run build -w daemon        # → daemon/dist/index.js (~220kb, 의존성 포함)

# 2. 서버로 복사
scp daemon/dist/index.js <server>:/opt/obsidian-git-sync/daemon.js

# 3. 서버에서 설정
sudo mkdir -p /etc/obsidian-git-sync
sudo cp deploy/daemon.env.example /etc/obsidian-git-sync/daemon.env
sudo chmod 600 /etc/obsidian-git-sync/daemon.env
# daemon.env 편집: VAULT_PATH / REMOTE(토큰 포함) / DEVICE_ID

# 4. systemd 등록
sudo cp deploy/obsidian-git-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-git-sync
journalctl -u obsidian-git-sync -f
```

## 검증 (E2E)

```bash
# 서버에서
echo "server bridge test $(date)" >> "$VAULT_PATH/bridge-test.md"
# ≈10초 내 로컬 Obsidian 에 bridge-test.md 등장 확인. 반대로 Obsidian 편집 → 서버 파일 갱신 확인.
```

## 주의

- **토큰**: `daemon.env` 평문. 전용 PAT(해당 repo 최소 권한) 발급 권장 — 기존 데모 노출 PAT 재사용 금지.
- `.obsidian/` 은 `.gitignore` 시드로 제외됨 — 서버 vault 에 Obsidian 설정이 있어도 동기화되지 않음.
- 같은 vault 에 daemon 두 개 띄우지 말 것(중복 커밋). DEVICE_ID 는 기기마다 달라야 함.
