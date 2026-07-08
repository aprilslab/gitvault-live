# GitVault Live

> Obsidian 플러그인 · 저장소 `gitvault-live` · 플러그인 id `gitvault-live`.

Obsidian vault 를 **git 기반으로 동기화**하는 시스템. 자동으로 문서를 만드는 **에이전트(헤드리스 git 클라이언트)** 와 Obsidian 앱 사용자가 같은 vault(=git repo, 1:1)를 공유한다. 대상 사용자는 **git 비개발자** — 브랜치/커밋/머지는 UI 뒤에 완전히 숨긴다.

**SoT = 표준 호스팅 git repo (HTTPS + 토큰).** GitHub / GitLab(SaaS·on-prem) / Gitea / Bitbucket 등 — 순수 git 만 쓰고 벤더 API 를 쓰지 않으므로 **특정 플랫폼에 종속되지 않는다**.

## 구성 요소

| 위치 | 역할 |
|------|------|
| `plugin/` | Obsidian 데스크톱 플러그인 (**활성 개발**). 편집 자동 동기화, 들어온 변경 인라인 표시, "저장" 버튼(squash-to-main). |
| `daemon/` | 에이전트용 헤드리스 git 클라이언트. 변경 감시 → main 연속 커밋·푸시, 60s sync-down. (특수 서버 없음) |
| `templates/` | 대상 repo 에 커밋할 `.gitattributes`(union) / `.gitignore` 템플릿. |
| `docs/` | 아키텍처 / 비개발자 온보딩 / 충돌 정책. |

## 동기화 모델 (요약)

- `main` — 공식 저장본. 에이전트는 **연속 push 로 직접 전진**, 사용자는 "저장"(squash)으로 전진. non-ff 는 `fetch → union merge → 재시도` 로 해소(force 금지, 서버 훅 없음).
- `wip/<device>/<ts>` — 편집 세션마다 lazy-fork 하는 ephemeral 작업 브랜치. **저장 시 삭제** → 원격 wip 누적 0, `main` 이력은 저장당 1커밋.
- 충돌 정책 = **union merge** (`*.md merge=union`) — 같은 파일 충돌 시 양쪽 hunk 를 모두 채택. 한계는 [`docs/CONFLICT-POLICY.md`](./docs/CONFLICT-POLICY.md).
- 저장은 checkout 없이 plumbing(`commit-tree` + `reset --soft`)으로 처리 → 열린 vault 의 워킹트리를 뒤집지 않는다.
- 협업 표시 = 에디터 **인라인 데코레이션**(CM6, blame 거터 + "작성 중" presence) + 보조 diff 패널. 프레즌스는 sync 단위(키입력별 실시간 아님).
- **daemon ↔ plugin 공존** — 같은 PC 에 둘 다 두면 `.git/ogs-plugin-alive` heartbeat lease 로 교대: Obsidian 실행 중=플러그인 담당, 종료=daemon 이 파일 변경을 main 에 반영.

```
                 ┌──────── 호스팅 git repo (SoT, main=공식본) ────────┐
                 └──▲───────────────────────────────▲─────────────────┘
      HTTPS+토큰   │ push main (연속)                │ HTTPS+토큰: fetch·squash push·push wip
   ┌──────────────┴─────────┐            ┌──────────┴───────────────────────┐
   │ 에이전트 daemon(헤드리스)│            │ 사용자 Obsidian + plugin          │
   │  watch→commit→union→push│            │  편집→wip 자동 커밋·푸시           │
   └─────────────────────────┘            │  60s sync-down · [저장]=squash    │
                                          │  들어온 변경 = 인라인 데코레이션  │
                                          └───────────────────────────────────┘
```

## 트레이드오프

- **데스크톱 전용** — union merge·squash 는 시스템 git 바이너리에서만 동작 (`isDesktopOnly: true`). 모바일 범위 밖.
- **토큰 평문 저장** — 플러그인 설정/`.git/config` 에 저장. 공용 PC 주의(기기별 최소권한 토큰 권장).
- **`.obsidian/` 미동기화** — 기기별 상태 + union 불가 json 충돌 회피.
- **다른 동기화 도구와 병행 불가** — LiveSync·Obsidian Sync·iCloud/OneDrive 실시간 동기화 폴더 위에 얹으면 충돌. 이 시스템 전용 vault 로.

## 설치

**요구사항:** Node 18+, git CLI.

### 빠른 설치 (스크립트)

스크립트가 소스를 받아 빌드까지 한다 — repo 를 clone 하지 않고 한 줄로 실행 가능.

**플러그인 (macOS / Linux)** — `<vault>` 는 Obsidian 으로 한 번 연 vault 폴더:
```bash
curl -fsSL https://raw.githubusercontent.com/aprilslab/gitvault-live/main/install.sh | bash -s -- plugin --vault <vault>
```

**플러그인 (Windows, PowerShell)**:
```powershell
iwr -useb https://raw.githubusercontent.com/aprilslab/gitvault-live/main/install.ps1 -OutFile install.ps1
.\install.ps1 plugin -Vault "C:\path\to\vault"
```

**daemon (서버)** — 파일 변경을 감시해 main 에 자동 반영. 상주 서비스로 등록:
```bash
# Linux(systemd)/macOS(launchd). --remote 생략 시 vault 의 기존 git 자격증명 재사용
curl -fsSL https://raw.githubusercontent.com/aprilslab/gitvault-live/main/install.sh | \
  bash -s -- daemon --vault <vault> --remote https://github.com/OWNER/REPO.git --token <PAT>
```
```powershell
# Windows(작업 스케줄러)
.\install.ps1 daemon -Vault "C:\vault" -Remote "https://github.com/OWNER/REPO.git" -Token <PAT>
```

설치 후 플러그인은 Obsidian 설정에서 repo URL+토큰 입력 → [연결 테스트]. daemon 은 바로 상주 시작.

daemon 서비스는 **vault 이름별 인스턴스**로 등록된다(기본 = vault 폴더명). 한 머신에서 vault 여러 개를 각각 돌리려면 그대로 여러 번 실행하거나 `--name`/`-Name` 으로 이름을 지정:
```bash
curl -fsSL .../install.sh | bash -s -- daemon --vault ~/wiki           # → gitvault-live@wiki
curl -fsSL .../install.sh | bash -s -- daemon --vault ~/notes --name notes  # → gitvault-live@notes
```

### 수동 설치

clone 후 직접:
```bash
git clone https://github.com/aprilslab/gitvault-live.git
cd gitvault-live
npm install && npm run build
./install.sh plugin --vault <vault>     # 또는 daemon
```

OS 별 상세 절차·서비스 관리·주의사항은 [`INSTALL.md`](./INSTALL.md), daemon 상주 배포는 [`daemon/DEPLOY.md`](./daemon/DEPLOY.md), 비개발자용은 [`docs/ONBOARDING.md`](./docs/ONBOARDING.md).

## 기여

기여 환영. 빌드·테스트·PR 흐름은 [`CONTRIBUTING.md`](./CONTRIBUTING.md), 설계는 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## 라이선스

[MIT](./LICENSE).
