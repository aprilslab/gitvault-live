# 아키텍처 (v3)

> 현재 구현 기준. 개요는 [`../README.md`](../README.md), 충돌 정책은 [`CONFLICT-POLICY.md`](CONFLICT-POLICY.md).
> v3 변경점: 영속 `wip/<device>` → **세션별 ephemeral `wip/<device>/<ts>`**, presence 소스 `origin/main` → **타 참여자 wip 브랜치**, 커밋 identity = **displayName**. 설계 근거: [`superpowers/specs/2026-07-06-ephemeral-wip-presence-design.md`](superpowers/specs/2026-07-06-ephemeral-wip-presence-design.md).

## 참여자

- **사용자 Obsidian (데스크톱)** — `plugin/` 이 편집을 세션 wip 브랜치로 자동 커밋·push 하고, "저장" 시 `origin/main` 위 1커밋으로 squash. 협업 상태를 에디터에 라인 단위로 표시(blame 거터 + "작성 중" presence).
- **에이전트 (헤드리스)** — `daemon/` 이 파일시스템을 감시 → 로컬 main 커밋 → `origin/main` union 병합 → main 에 직접 연속 push. 서버 없는 순수 git 클라이언트.
- **SoT = 표준 호스팅 git repo** — GitHub / GitLab(SaaS·on-prem) / Gitea / Bitbucket. **HTTPS + 토큰** 인증, 벤더 API 미사용(순수 git).

## 브랜치 모델 (플러그인, v3)

세션 상태 `currentWip: string | null` 로 idle/editing 을 구분한다.

| 상태 | HEAD | 의미 |
|---|---|---|
| **idle** (`currentWip === null`) | 로컬 `main` (= `origin/main` 추종) | 편집 없음. 공식본을 그대로 봄. |
| **editing** (`currentWip !== null`) | `wip/<device>/<epochMs>` | 미저장 편집 세션. 편집분이 이 브랜치에 실시간 쌓임. |

- **`wip/<device>/<ts>` 는 세션마다 새로 fork** — 첫 편집(dirty)에서 lazy 생성, **저장 시 삭제**(로컬 `branch -D` + 원격 `push origin --delete`). 재사용하지 않음 → 원격 wip 누적 0, `main` 이력은 저장당 1커밋.
- `device = deviceId slug` (`hostname-slug + '-' + 랜덤4자리`, 설정에 영속). `ts = Date.now()`.
- **레거시 마이그레이션**: 로드 시 이전 모델의 영속 `wip/<device>`(ts 없음)와 자기 stale ts-wip 를 삭제. **fork 전에 실행**해야 D/F ref 충돌(`wip/<device>` 파일이 `wip/<device>/<ts>` 디렉토리 생성을 막음)을 피한다.
- 세션 유니크 브랜치라 push 는 평범한 fast-forward(force 불필요).

> 대비: 헤드리스 `daemon/` 은 에디터가 없어 로컬 main 을 직접 쓰고 main 에 연속 push 한다(옛 모델 유지).

## 핵심 시퀀스 (플러그인)

### 로드 — `ensureRepo` → `ensureOnMain`
1. `fetch origin --prune`.
2. **base 결정(데이터손실 방지 핵심):** 로컬 `main` 이 있으면 그것(=마지막 동기화 지점 `oldMain`)을 advance 하지 않고 HEAD 만 올린다. 첫 클론이면 base = `origin/main`.
3. 레거시/stale 자기 wip 삭제(`deleteOwnWips`) — **fork 전**.
4. 원격 전용 파일 실체화(`checkout-index`, no-clobber), `.gitignore`/`.gitattributes(union)` seed(원격 파일 존중, add 전 배치).
5. **dirty 판정은 base(oldMain) 기준**:
   - clean → `merge --ff-only origin/main`(팀원 저장분을 디스크에 반영), `currentWip = null`(idle).
   - dirty → **base 에서 adopt wip fork** + adopt 커밋(`currentWip` 설정). 다음 `mergeDown` 이 `origin/main` 을 3-way union 병합.

  > 왜 base 기준인가: 방금 fetch 한 `origin/main` 으로 main 을 먼저 advance 하면, 앱이 닫힌 사이 팀원이 저장해 origin/main 만 앞선 **clean-behind 재연결**이 "로컬 편집"으로 오탐 → adopt wip 이 origin/main 을 조상으로 봐 union 이 no-op → 이어진 저장이 stale tree 로 origin/main 을 덮어 **팀원 저장분 유실**. oldMain 기준 판정이 이를 막는다.

### 자동 동기화 — `AutoSync`
- vault `modify/create/delete/rename` → 디바운스 → `commitAndPushWip()`:
  - `flushCommit`: 열린 에디터 버퍼 flush → `add -A` → 변경 있고 `currentWip===null` 이면 wip fork → 커밋.
  - `pushWip`: 세션 wip 를 origin 에 push(평범).
- 주기 타이머(`syncSeconds`) → `syncDown(merge?, isStillIdle)`: `fetch` + (idle 이면) `mergeDown`.
- **타이핑 중 merge 연기(TOCTOU)**: `isStillIdle()`(마지막 키입력 후 `IDLE_MERGE_MS=5s`)를 워킹트리 쓰기 직전 재평가 → 느린 fetch 동안 타이핑 재개 시 merge 를 다음 사이클로 연기(열린 버퍼 보호).

### 저장 — `squashMergeToMain` → `saveLocked`
1. `flushCommit`(미저장 편집 커밋). `currentWip===null`(편집 전무) → `nochange`.
2. 재시도 루프(≤3, jitter): `fetch` → `mergeDown`(origin/main → wip, `.md` union) → merged tree 를 `commit-tree tree -p origin/main -m "저장: <displayName> …"` 로 squash → `push origin <commit>:refs/heads/main`(non-ff 시 재시도).
3. `finishToMain`: `main` 을 squash 커밋으로 이동 + `symbolic-ref HEAD main` + `reset --mixed`(동일 tree → 워킹트리·mtime 무변경) → **wip 삭제**(로컬+원격) → `currentWip = null`.

### sync-down 병합 — `mergeDown`
- idle(`currentWip===null`): `merge --ff-only origin/main`(로컬 커밋 없어 항상 ff).
- editing: `merge -X theirs --no-edit origin/main`. `.md` 는 `.gitattributes` union 이 `-X theirs` 보다 우선(양쪽 병합) → 동시 편집 공존. modify/delete 잔여 충돌은 "수정이 삭제를 이긴다" 폴백.

## 협업 표시 (에디터)

세 레이어가 독립적으로 동작한다.

| 레이어 | 소스 | 렌더 | 설정 |
|---|---|---|---|
| **blame 거터** | `git blame origin/main` (라인별 `{author, epoch}`) | 좌측 거터 `작성자 · 상대시간`, 로컬/미저장 줄은 빈칸 | `showLineBlame`(기본 on), 커맨드 `ogs-toggle-line-blame` |
| **작성 중 presence** | **타 참여자 wip 브랜치** (`git show origin/wip/<other>/<ts>:<path>`) | 라인 끝 `✍ <이름> 작성 중` 배지 | `showInlineChanges` |
| **내 편집 하이라이트** | `origin/main` vs 내 버퍼(added 라인) | 파란 라인 하이라이트 | `showInlineChanges` |

- **presence 계산(순수 `mergePeerHunks`)**: 각 peer wip 내용을 **공유 base(origin/main)** 와 diff → peer 가 base 대비 새로 쓴 줄만 배지. (내 버퍼가 아니라 base 와 비교 — 내 편집이 남의 것으로 오탐되는 것 방지.)
- **staleness**: 마지막 커밋이 5분(`PEER_WIP_STALE_MS`) 지난 wip 는 제외(크래시 잔재 유령 배지 억제).
- **친근한 이름(displayName)**: 설정 `displayName` → git `user.name`. blame·presence 둘 다 이 이름을 읽는다(단일 소스). 브랜치명·email 은 deviceId 유지(유니크). 미설정 시 deviceId 슬러그 폴백.
- git 서브프로세스(blame·peer 목록·peer 내용)는 sync 주기에만 실행하고 캐시 → **타이핑은 인메모리 재diff**(키입력당 git spawn 0).

## 컴포넌트

```
plugin/src/
  main.ts                 # 플러그인 진입 — 확장 등록, 갱신 오케스트레이션, GitManager/AutoSync 배선
  sync/AutoSync.ts        # vault 이벤트 → 디바운스 커밋·push + 주기 sync-down
  git/
    GitManager.ts         # git 엔진: ensureRepo/ensureOnMain(생명주기), flushCommit/pushWip, saveLocked/finishToMain,
                          #   mergeDown, mainBlameLines(blame), listPeerWips/peerWipContent(presence). PromiseQueue 직렬화.
    PromiseQueue.ts       # 모든 git op 직렬화(.git/index.lock 충돌 방지)
  editor/
    lineDiff.ts           # 인메모리 LCS diff(alignLines 공유 primitive) — blame/presence/하이라이트 공용
    diffHunks.ts          # DiffHunk 타입 + unified-diff 파서
    blameLines.ts         # alignBlame — 버퍼 각 줄에 origin 작성자 정렬(위치정확)
    relativeTime.ts       # 상대/절대 시각 포맷(순수, nowMs 주입)
    BlameGutter.ts        # CM6 거터 확장(작성자·상대시간 마커)
    peerPresence.ts       # mergePeerHunks/isStalePeer — peer wip → 작성중 훅(순수)
    CollabDecorations.ts  # CM6 presence/하이라이트 데코(PresenceWidget)
    saveKeymap.ts         # Mod-s / Mod-Shift-s 저장 keymap
  ui/
    StatusBar.ts          # 저장대기/저장됨/동기화/에러 상태
    DiffPanel.ts          # 동시 편집 현황 패널
  settings.ts             # 설정(repo/토큰/deviceId/autoSyncSeconds/showInlineChanges/showLineBlame/displayName) + 설정탭
daemon/                   # 헤드리스 에이전트용 git 클라이언트(main 연속 push) — 별도 모델
```

## 데이터손실 안전장치

- **union merge**: `.md` 는 `.gitattributes merge=union` — 동시 같은 파일 편집이 양쪽 보존(원격 승 아님). 모든 연결 경로에서 seed 보장.
- **TOCTOU 연기**: 타이핑 중 워킹트리 merge(에디터 리로드) 연기 → 미저장 버퍼 보호.
- **base 기준 재판정**: 재연결 시 clean-behind 를 로컬 편집으로 오탐하지 않음(팀원 저장분 유실 방지).
- **워킹트리 무변경 전환**: main 전환은 `symbolic-ref`+`reset --mixed`(동일 tree) — 파일·mtime 불변, 열린 버퍼 미파괴. `reset --hard`/`checkout -f` 미사용.
- **fork 전 마이그레이션**: 레거시 wip 를 fork 전에 삭제 → D/F 충돌로 sync 가 깨지지 않음.

## 알려진 한계 / 후속

- **wip push 재시도 갭**: 실패한 `pushWip` 는 다음 편집(`commitAndPushWip`)에서만 재시도됨 — 주기 `runSync`(syncDown)는 push 를 재시도하지 않는다. 네트워크 blip 시 다음 편집까지 origin 이 지연될 수 있다. → `runSync` 에 pending wip push 재시도 추가 여지.
- **presence 앵커 근사**: 배지는 peer 의 base 대비 변경 위치(base 좌표)에 앵커 — 내 버퍼가 크게 diverge 하면 한두 줄 오차(라인 근사 설계).
- **displayName 동명이인**: 표시이름은 유니크 강제 없음(식별자는 deviceId). 같은 이름 두 명이면 배지에서 구분 안 됨.
- **미저장 로컬 파일 삭제 미보존**: 재연결 adopt 는 `add --ignore-removal` 이라 미저장 '삭제'는 되돌려짐(의도적 — 대량 삭제 전파 방지).
- **presence over-report(희귀)**: origin/main 이 stale peer 의 fork base 를 지나 advance 하면 peer 훅이 base-diverged 줄을 과표시할 수 있음(staleness 로 대부분 필터).
- **토큰 평문**: `data.json` 에 토큰 평문 저장(MVP). OS 키체인 미사용.
- **테스트 커버리지**: Bug-B(presence base) 가드는 순수함수엔 있으나 `main.ts` 콜사이트(base 전달) 회귀는 미가드 — thin helper 추출 + 테스트 여지.
