# E2E 검증 시나리오 (수동)

자동 게이트(`tsc` + esbuild build + `daemon` smoke + `parseUnifiedHunks` 단위테스트)는 git 시퀀스와 순수 로직을 커버하지만, **CM6 인라인 데코레이션·패널·모달의 실제 렌더는 살아있는 Obsidian 이 필요**하다. 아래는 사람이 한 번 도는 절차.

## 사전 준비

1. **테스트용 원격 repo** — 빈 GitHub(또는 GitLab/Gitea) repo 하나. 쓰기 토큰 발급.
   - (기존 LiveSync `wiki` vault·실 문서 repo 는 건드리지 말 것 — 이중 동기화 충돌.)
2. **플러그인 로드** — `npm run build -w plugin` → `plugin/{main.js,manifest.json,styles.css}` 를
   `<테스트vault>/.obsidian/plugins/obsidian-git-sync/` 에 복사. Obsidian 에서 활성화 →
   설정에 repo URL + 토큰 입력 → **[연결 테스트]** 성공 확인.
3. **에이전트 데몬** — 별도 디렉터리를 vault 로 삼아:
   ```bash
   VAULT_PATH=/tmp/agent-vault \
   REMOTE='https://<user>:<token>@github.com/<owner>/<repo>.git' \
   DEVICE_ID=agent \
   node daemon/dist/index.js
   ```

## 시나리오 1 — 에이전트 변경이 사용자에게 도착 (인라인 표시)

1. 에이전트 vault 에 `note.md` 생성/편집 → 데몬이 수 초 내 `origin/main` 에 push (로그 확인).
2. 사용자 Obsidian 에서 최대 60s(autoSyncSeconds) 대기 → **상태바 "동기화됨"**.
3. `note.md` 를 Source/라이브프리뷰로 열기 → **들어온 라인이 `ogs-incoming-line` 하이라이트**,
   로컬에 아직 없는 라인은 **`ogs-incoming-ghost` 위젯**으로 미리보기.
4. 리본 `git-compare`(동시 편집 현황) → 패널 **"들어온 변경"** 에 `note.md` 노출, 클릭 시 열림.
   - ✅ 기대: 타이핑 중이 아니면(≥5s idle) 다음 사이클에 union 병합돼 본문에 실제 반영.

## 시나리오 2 — 사용자 편집 → 저장(squash)

1. 사용자가 노트 편집 → 3s 디바운스 후 **`wip/<device>` 에 자동 커밋·푸시**(`git ls-remote` 로 확인).
2. 리본 `save` 또는 커맨드 **"저장 — 공식본에 반영"** → 모달에 **변경 파일 목록** → **[저장]**.
3. `git log origin/main` → **1커밋(`저장: <device> …`)으로 squash** 확인. `wip/<device>` 는 새 main 으로 리셋.
4. 다른 참여자(에이전트/2번째 기기)가 60s 내 sync-down 으로 수신.
   - ✅ 기대: 저장 직후 열린 노트가 뒤집히지 않음(`reset --soft`, 워킹트리 무변경).

## 시나리오 3 — 동시 편집 → union 병합

1. 같은 `note.md` 를 사용자는 **끝 줄**, 에이전트는 **첫 줄** 에 서로 다른 내용 추가.
2. 에이전트는 main 에 push, 사용자는 [저장].
3. `git show origin/main:note.md` → **양쪽 내용 모두 존재**(union), 충돌 마커 없음.
   - ⚠️ union 한계는 [`CONFLICT-POLICY.md`](./CONFLICT-POLICY.md) (중복 제거 안 함, 같은 줄 동시 수정은 둘 다 남음).

## 통과 기준

- 상태바 상태 전이(대기→동기화 중→동기화됨/오류)가 조작과 일치.
- 인라인 데코·패널이 도착 변경을 반영, 저장 모달이 outgoing 목록을 정확히 표시.
- main 히스토리: 에이전트=연속 커밋, 사용자 저장=squash 1커밋. 충돌 마커 0.
- 토큰이 Notice/콘솔 로그에 평문 노출되지 않음(`//***@` 마스킹).
