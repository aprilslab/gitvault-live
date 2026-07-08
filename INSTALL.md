# 설치 가이드

기기 구성 예 (전부 같은 repo 를 바라본다):

```
호스팅 git repo (SoT) ←── HTTPS+토큰 ──→  macOS PC   : Obsidian + plugin
                     ←── HTTPS+토큰 ──→  Windows PC : Obsidian + plugin
                     ←── HTTPS+토큰 ──→  개인 서버   : daemon (헤드리스)
```

- **Obsidian 을 여는 기기** → `plugin/` 설치 (§2)
- **에디터 없이 파일만 바뀌는 기기**(서버, 에이전트 구동 머신) → `daemon/` 설치 (§3)
- **개인 PC 에서 둘 다** — 평소 Obsidian + 자리 비울 때 AI 가 파일 변경 → **둘 다 설치 가능**(§3-4). heartbeat lease 로 자동 교대하니 중복 커밋 없음.

> **빠른 설치:** 대부분은 [README 의 스크립트 한 줄](./README.md#설치)(`install.sh` / `install.ps1`)이면 빌드·복사·서비스 등록까지 끝난다. 아래는 스크립트가 하는 일의 수동 절차·세부 옵션·서비스 관리·주의사항.

---

## 1. 공통 준비 (최초 1회)

1. **대상 repo 생성** — GitHub/GitLab/Gitea 등 HTTPS 지원 아무 호스트. 비워둬도 됨(첫 클라이언트가 seed).
2. **액세스 토큰 발급** — 해당 repo 쓰기 권한. **기기마다 별도 토큰 권장**(유출 시 개별 회수).
3. (선택) `templates/` 의 `.gitattributes`/`.gitignore` 를 repo 루트에 커밋 — 안 해도 클라이언트가 자동 seed.

### 빌드 (배포 파일 만들기, 개발 머신에서 1회)

```bash
git clone <이 repo> && cd gitvault-live
npm install
npm run build
# 산출물:
#   plugin/main.js, plugin/manifest.json, plugin/styles.css   ← Obsidian 기기용
#   daemon/dist/index.js (단일 파일, 의존성 포함 ~220kb)        ← 서버용
```

---

## 2. Obsidian 플러그인 (macOS / Windows)

### 2-1. git 설치 (플러그인이 시스템 git 사용 — 필수)

| OS | 방법 | 확인 |
|---|---|---|
| macOS | `xcode-select --install` 또는 `brew install git` | `git --version` |
| Windows | [Git for Windows](https://git-scm.com/download/win) 또는 `winget install Git.Git` (설치 후 Obsidian 재시작 — PATH 반영) | PowerShell 에서 `git --version` |

> Windows 줄바꿈: repo 의 `.gitattributes` 가 `eol=lf` 를 강제하므로 `autocrlf` 설정과 무관하게 안전.

### 2-2. 플러그인 파일 복사

빌드 산출물 3개를 vault 의 플러그인 폴더에 넣는다:

```
<vault>/.obsidian/plugins/gitvault-live/
├── main.js
├── manifest.json
└── styles.css
```

- macOS 예: `~/Documents/wiki/.obsidian/plugins/gitvault-live/`
- Windows 예: `C:\Users\<user>\Documents\wiki\.obsidian\plugins\gitvault-live\`
- `.obsidian` 폴더가 숨김이면: macOS Finder `Cmd+Shift+.`, Windows 탐색기 "숨긴 항목" 체크.

### 2-3. 활성화 + 연결

1. Obsidian 설정 → 커뮤니티 플러그인 → **제한 모드 해제** → gitvault-live **활성화**.
2. 플러그인 설정 입력:
   - **저장소 URL** — `https://github.com/<owner>/<repo>.git`
   - **사용자명** — 보통 비움 (GitHub/Gitea 토큰 단독. GitLab 은 `oauth2`)
   - **토큰** — 이 기기용 토큰
   - **표시 이름** — blame·"작성 중" 배지에 뜨는 이름 (예: `jaei`)
3. **[연결 테스트]** → 성공하면 끝. 이후 전부 자동 (편집→자동 동기화, [저장]→main 확정).

기기 식별자(deviceId)는 최초 로드 시 자동 생성·영속 — mac 과 windows 가 서로 브랜치를 침범하지 않는다. 같은 절차를 기기마다 반복하면 됨.

비개발자에게 줄 짧은 안내는 [`docs/ONBOARDING.md`](./docs/ONBOARDING.md).

---

## 3. daemon (서버 / 헤드리스 기기)

요구사항: **Node 18+**, **git CLI**, vault 디렉터리 쓰기 권한. 기존 파일이 있어도 됨 — 첫 기동 시 adopt 온보딩이 로컬·원격 양쪽을 보존한다.

공통 환경변수 (`daemon/deploy/daemon.env.example` 참조):

```bash
VAULT_PATH=<vault>                                          # 감시할 vault 폴더 절대경로
REMOTE=https://<user>:<token>@github.com/<owner>/<repo>.git  # 토큰 포함 URL
DEVICE_ID=home-server                                        # 기기마다 유일하게
DEBOUNCE_MS=3000                                             # (선택) 커밋 디바운스
```

수동 실행(모든 OS 동일): `node daemon.js` (env 설정 후). 상주시키려면 아래 OS 별 방법.

### 3-1. Linux (systemd) — 권장 경로

```bash
scp daemon/dist/index.js <server>:/opt/gitvault-live/daemon.js
# 이후 서버에서: env 파일 + systemd 유닛 등록
```

상세 절차·유닛 파일: [`daemon/DEPLOY.md`](./daemon/DEPLOY.md), [`daemon/deploy/`](./daemon/deploy/).

### 3-2. macOS (launchd)

`~/Library/LaunchAgents/com.gitvault-live.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gitvault-live.daemon</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/opt/gitvault-live/daemon.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>VAULT_PATH</key><string>/Users/me/vault</string>
    <key>REMOTE</key><string>https://user:token@host/owner/repo.git</string>
    <key>DEVICE_ID</key><string>mac-server</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/ogs-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/ogs-daemon.log</string>
</dict></plist>
```

```bash
# node 경로 확인해서 plist 에 반영: which node
launchctl load ~/Library/LaunchAgents/com.gitvault-live.daemon.plist
tail -f /tmp/ogs-daemon.log
```

### 3-3. Windows (작업 스케줄러)

1. 배치 파일 `C:\gitvault-live\run-daemon.cmd`:

   ```bat
   @echo off
   set VAULT_PATH=C:\vault
   set REMOTE=https://user:token@host/owner/repo.git
   set DEVICE_ID=win-server
   node C:\gitvault-live\daemon.js >> C:\gitvault-live\daemon.log 2>&1
   ```

2. 등록 (관리자 PowerShell):

   ```powershell
   schtasks /Create /TN "gitvault-live" /SC ONSTART /RU "%USERNAME%" `
     /TR "C:\gitvault-live\run-daemon.cmd"
   schtasks /Run /TN "gitvault-live"   # 즉시 시작
   ```

   로그인 세션과 무관하게 항상 돌리려면 [NSSM](https://nssm.cc) 으로 서비스 등록해도 된다:
   `nssm install gitvault-live "C:\Program Files\nodejs\node.exe" C:\gitvault-live\daemon.js`
   (환경변수는 `nssm set gitvault-live AppEnvironmentExtra VAULT_PATH=... REMOTE=... DEVICE_ID=...`)

---

## 3-4. 개인 PC 공존 — Obsidian 닫힌 동안 AI 변경을 main 에 (heartbeat lease)

평소엔 Obsidian 으로 작업하고, 자리를 비운 사이 AI 에이전트가 같은 vault 파일을 바꾸는 경우.
**같은 PC 에 플러그인(§2)과 daemon(§3)을 둘 다** 깔면 자동 교대한다:

- Obsidian 실행 중 → 플러그인이 담당(편집→wip, `[저장]`→main). daemon 은 후퇴.
- Obsidian 종료 → daemon 이 인수 → AI 파일 변경을 감지해 **main 에 직접 반영**.

추가 설정 없음 — 플러그인이 `.git/ogs-plugin-alive` 를 주기 기록하고, daemon 이 그 신선도(30초)로 판정한다.
같은 vault 를 `VAULT_PATH` 로 가리키게만 하면 된다(플러그인 vault 경로와 동일 폴더).

> **주의:** Obsidian 을 닫으면 "초안(미저장) vs 발행(main)" 구분이 사라진다 — 닫기 직전 미저장 편집도
> daemon 이 곧 main 에 올린다(디스크가 진실). 초안을 main 에 안 올리려면 닫기 전에 되돌리거나 `[저장]`.

## 4. 검증 (E2E)

1. 서버(daemon 기기)에서: `echo "bridge test" >> $VAULT_PATH/bridge-test.md`
2. ≈10초 내 각 Obsidian 기기에 `bridge-test.md` 등장 (daemon 디바운스 3s + 플러그인 pull 주기 5s).
3. 반대로 Obsidian 에서 노트 편집 → 서버 파일에 반영 확인 (daemon sync-down 주기 60s + [저장] 시 main 반영).

## 5. 주의

- **토큰 평문** — 플러그인 `data.json`·`.git/config`, daemon env 파일 모두 평문. 파일 권한(600) 관리 + 기기별 토큰.
- **DEVICE_ID 유일성** — 모든 기기(플러그인·daemon)의 식별자가 서로 달라야 함. 플러그인은 자동 보장, daemon 은 env 로 지정 시 주의.
- **같은 vault 에 plugin+daemon 은 heartbeat lease 로만** — 같은 PC 공존은 §3-4 방식(자동 교대)이라 안전. 단 **다른 두 기기의 daemon 을 같은 vault 폴더에** 붙이는 식은 금물(lease 는 로컬 `.git` 파일 기반이라 기기 간 조율 못 함).
- **다른 동기화 도구와 병행 금지** — LiveSync·Obsidian Sync·iCloud/OneDrive 실시간 동기화 폴더 위에 얹으면 충돌. vault 는 이 시스템 전용 디렉터리로.
- `.obsidian/` 은 동기화되지 않음(의도) — 기기별 플러그인·테마 설정은 각자 관리.
