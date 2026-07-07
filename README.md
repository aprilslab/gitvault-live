# obsidian-git-sync

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
- `wip/<device>` — 사용자 기기별 상시 작업 브랜치. 단일 작성자 전용, 자기 저장 리셋 시에만 `--force-with-lease`.
- 충돌 정책 = **union merge** (`*.md merge=union`) — 같은 파일 충돌 시 양쪽 hunk 를 모두 채택. 한계는 [`docs/CONFLICT-POLICY.md`](./docs/CONFLICT-POLICY.md).
- 저장은 checkout 없이 plumbing(`commit-tree` + `reset --soft`)으로 처리 → 열린 vault 의 워킹트리를 뒤집지 않는다.
- 협업 표시 = 에디터 **인라인 데코레이션**(CM6) + 보조 diff 패널. 프레즌스는 sync 단위(키입력별 실시간 아님).

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
- **토큰 평문 저장** — 플러그인 설정/`.git/config` 에 저장(MVP). 공용 PC 주의.
- **`.obsidian/` 미동기화** — 기기별 상태 + union 불가 json 충돌 회피.
- **MVP 는 별도 테스트 vault** — 기존 LiveSync `wiki` vault 는 이중 동기화 충돌 회피 위해 건드리지 않는다.

## 설치

OS 별(macOS/Windows 플러그인, Linux/macOS/Windows daemon) 전체 절차는 [`INSTALL.md`](./INSTALL.md).

1. 관리자: 대상 repo 생성 + `templates/` 의 `.gitattributes`/`.gitignore` 를 루트에 커밋(또는 플러그인이 빈 repo seed). 에이전트 쪽은 `daemon/` 을 `VAULT_PATH`/`REMOTE`(HTTPS+토큰) env 로 구동 — 상주 배포는 [`daemon/DEPLOY.md`](./daemon/DEPLOY.md).
2. 사용자: 플러그인 설치 → 설정에서 repo URL + 토큰 입력 → [연결 테스트]. 이후 전 과정 자동.

비개발자용 상세 절차는 [`docs/ONBOARDING.md`](./docs/ONBOARDING.md).
