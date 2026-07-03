# 아키텍처 (v2)

> 이 문서는 구현이 진행되며 확정된 사실을 요약한다. 전체 개요는 [`../README.md`](../README.md).

## 참여자

- **에이전트 (헤드리스)** — markdown 을 쓰는 파일시스템. `daemon/` 이 감시 → 로컬 main 커밋 → `origin/main` union 병합 → **main 에 직접 연속 push**. 특수 서버 없이 순수 git 클라이언트.
- **사용자 Obsidian (데스크톱)** — `plugin/` 이 편집을 `wip/<device>` 로 자동 동기화하고, "저장" 시 main 에 1커밋 squash. 들어온 변경은 에디터에 인라인 데코레이션으로 표시.
- **SoT = 표준 호스팅 git repo** — GitHub / GitLab(SaaS·on-prem) / Gitea / Bitbucket 등. **HTTPS + 토큰** 인증. 특정 플랫폼 종속 없음(순수 git, 벤더 API 미사용).

## 브랜치 불변식

- `main`: 공식 저장본. 에이전트는 **연속 push 로 직접 전진**, 사용자는 "저장"(squash)으로 전진. non-ff 는 `fetch → union merge → 재시도(≤3, jitter)` 로 해소. force 금지. (pre-receive 훅 없음 — 호스트 브랜치 보호 규칙은 선택.)
- `wip/<device-id>`: 사용자 단일 작성자 전용. `device-id = hostname-slug + '-' + 랜덤4자리`. 자기 저장 리셋 때만 `--force-with-lease`.
- **플러그인은 로컬 `main` 을 만들지 않는다** — 항상 `wip/<device>` 체크아웃, main 은 `origin/main` ref 로만 취급(열린 vault 워킹트리 보호). 헤드리스 데몬은 에디터가 없어 로컬 main 을 쓴다.

## 핵심 시퀀스

- **sync-down**: `commit(flush) → fetch → merge -X theirs origin/main`. `.md` 는 union 이 `-X theirs` 보다 우선 적용(양쪽 병합), non-md 만 main 우선. modify/delete 잔여 충돌은 "수정이 삭제를 이긴다" 폴백.
- **에이전트 push-to-main** (`daemon`): `flush → fetch → union merge → push HEAD:main`(non-ff 시 재시도).
- **저장(squash)** (`plugin`): sync-down 후 `TREE=HEAD^{tree}` → `commit-tree TREE -p origin/main` → `push :main`(non-ff 시 재시도) → `reset --soft` → `push --force-with-lease wip`. 워킹트리를 건드리는 단계는 sync-down merge 하나뿐.

## 협업 표시 & 이벤트 루프 차단

- **인라인 데코레이션**: 플러그인은 `registerEditorExtension()`(CM6)으로 들어온(에이전트) 변경을 에디터 본문에 하이라이트/ghost 위젯으로 표시. 프레즌스는 sync 단위(키입력별 실시간 아님).
- **이벤트 루프**: git 이 워킹트리를 바꾸는 op 전후로 `suppressEvents` 플래그를 세우고, `commitAll` 의 `status --porcelain` empty-skip 이 구조적 종결자(제거 금지). 타이핑 중엔 워킹트리 merge 를 idle 로 미뤄 열린 에디터를 뺏지 않는다.
