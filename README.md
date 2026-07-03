# obsidian-git-sync

Obsidian vault를 **git 기반으로 동기화**하는 시스템. 자동으로 문서를 만드는 에이전트 서버(hermes)와 Obsidian 앱 사용자가 같은 vault를 공유한다. 대상 사용자는 **git 비개발자** — 브랜치/커밋/머지는 UI 뒤에 완전히 숨긴다.

전체 설계·구현 단계는 [`PLAN.md`](./PLAN.md) 참조.

## 구성 요소

| 위치 | 역할 |
|------|------|
| `daemon/` | hermes 파일 감시 데몬. 변경 → 자동 커밋·푸시, idle 5분 → main 자동 저장, 60s → sync-down. |
| `plugin/` | Obsidian 데스크톱 플러그인. 편집 자동 동기화, 타 참여자 WIP 확인, "저장" 버튼(squash-to-main). |
| `server-setup/` | hermes bare repo 초기화 + 기기 SSH 키 등록 + vault용 `.gitattributes`/`.gitignore` + systemd unit. |
| `docs/` | 아키텍처 / 비개발자 온보딩 / 충돌 정책. |

## 동기화 모델 (요약)

- `main` — 공식 저장본. **squash push로만 전진**(force 금지, non-ff는 pre-receive 훅이 거절).
- `wip/<device>` — 참여자별 상시 작업 브랜치. 단일 작성자 전용, 자기 저장 리셋 시에만 `--force-with-lease`.
- 충돌 정책 = **union merge** (`*.md merge=union`) — 같은 파일 충돌 시 양쪽 hunk를 모두 채택. 한계는 [`docs/CONFLICT-POLICY.md`](./docs/CONFLICT-POLICY.md).
- 저장은 checkout 없이 plumbing(`commit-tree` + `reset --soft`)으로 처리 → 열린 vault의 워킹트리를 뒤집지 않는다.

```
hermes /home/ubuntu/wiki ──daemon──▶ wip/hermes ──idle 5m──▶ main
                                          │                     ▲
                              ~/vault.git (bare, SSH)           │ squash push
                                          │                     │
사용자 Mac  Obsidian+plugin ──▶ wip/<device> ──[저장]──────────┘
                    ▲                                 
                    └── 60s sync-down (origin/main 병합)
```

## 트레이드오프

- **데스크톱 전용** — union merge·squash는 시스템 git 바이너리에서만 동작 (`isDesktopOnly: true`). 모바일 범위 밖.
- **`.obsidian/` 미동기화** — 기기별 상태 + union 불가 json 충돌 회피. 기기 간 플러그인 설정은 공유 안 됨.
- **MVP는 별도 테스트 vault** — 기존 LiveSync `wiki` vault는 이중 동기화 충돌 회피 위해 건드리지 않는다.

## 설치

1. hermes: `server-setup/init-bare-repo.sh` → 데몬 배포 → systemd 등록. (Phase 0~1)
2. 사용자: 플러그인 설치 → "연결 설정" 위저드로 SSH 키 생성 → 공개키를 관리자에게 전달. (Phase 2)

비개발자용 상세 절차는 [`docs/ONBOARDING.md`](./docs/ONBOARDING.md).
