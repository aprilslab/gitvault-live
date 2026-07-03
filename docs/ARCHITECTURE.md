# 아키텍처

> 정본은 [`../PLAN.md`](../PLAN.md). 이 문서는 구현이 진행되며 확정된 사실을 요약한다.

## 참여자

- **hermes (Box#1, Oracle 152.69.239.170)** — 에이전트가 `/home/ubuntu/wiki`에 markdown을 쓴다. `daemon/`이 감시 → 커밋·푸시, idle 자동 저장, sync-down.
- **사용자 Obsidian (데스크톱)** — `plugin/`이 편집을 자동 동기화하고 "저장"으로 main에 반영.
- **bare repo `~/vault.git`** — hermes 박스에 위치, SSH 엔드포인트. 앱 기기는 SSH, hermes 데몬은 로컬 경로로 접근.

## 브랜치 불변식

- `main`: squash push로만 전진. force 금지 — `pre-receive` 훅이 non-ff 거절. bare repo의 per-ref compare-and-swap이 동시 저장을 직렬화(락 불필요).
- `wip/<device-id>`: 단일 작성자 전용. `device-id = hostname-slug + '-' + 랜덤4자리`. 자기 저장 리셋 때만 `--force-with-lease`.
- 로컬에 `main` 브랜치를 만들지 않는다 — 항상 `wip/<device>` 체크아웃, main은 `origin/main` ref로만 취급.

## 핵심 시퀀스

- **sync-down**: `commit(flush) → fetch → merge -X theirs origin/main`. `.md`는 union이 `-X theirs`보다 우선 적용(양쪽 병합), non-md만 main 우선. modify/delete 잔여 충돌은 "수정이 삭제를 이긴다" 폴백.
- **저장(squash)**: sync-down 후 `TREE=HEAD^{tree}` → `commit-tree TREE -p origin/main` → `push :main`(non-ff 시 재시도) → `reset --soft` → `push --force-with-lease wip`. 워킹트리를 건드리는 단계는 sync-down merge 하나뿐.

## 이벤트 루프 차단

플러그인은 git이 워킹트리를 바꾸는 op 전후로 `suppressEvents` 플래그를 세우고, `commitAll`의 `status --porcelain` empty-skip이 구조적 종결자 역할(제거 금지).
