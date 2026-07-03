# obsidian-git-sync 구현 — Loop Queue

> **이 파일이 루프의 메모리다.** 챗 히스토리는 iteration 사이 압축/소실될 수 있으니
> 매 iteration은 이 파일 + [`../PLAN.md`](../PLAN.md)를 **다시 읽고** 시작한다. 큐가 진실의 원천.
> 항목 1개 끝낼 때마다 status·commit 갱신 후 커밋.

## 루프 계약 (매 iteration 정확히 1개 항목)
1. 이 파일 + PLAN.md 읽기 → `status: pending` 중 depends 충족된 첫 1개.
2. 그 1개만 완전 처리: 조사/역설계 → 구현 → 검증 → commit.
3. **검증 = `npm install` 후 해당 workspace `npm run build` + `npx tsc --noEmit` 통과.** git 로직(daemon/save-flow)은 임시 bare repo 스모크까지.
4. **destructive 금지**: 실 hermes 박스 SSH·구동, 실 Obsidian 구동, GitHub release/PR publish는 **실행하지 말고** 배선·절차 기술만. (배포는 큐 완료 후 사용자 인계.)
5. 성공 시 항목 `status: done` + `commit: <hash>` 기록, 큐도 commit.
6. 막히면 즉시 멈추고 `blocker:` 기록 + 보고. 다음으로 안 넘어감.
7. 한 iteration = 한 항목, 동시 금지. 큰 항목은 v1 스코프만.
8. pending 남으면 ScheduleWakeup 60s로 같은 /loop-queue prompt 재예약, 0개면 멈추고 최종 요약.
- 프로젝트 규칙: 커밋 conventional(`feat(phase-N): …`), attribution off. bash에서 bare `-n` 플래그 금지(block-no-verify 훅 오탐), `--no-edit` 대신 `GIT_MERGE_AUTOEDIT=no`.

## Queue

### 1. daemon — hermes 감시 데몬 (PLAN Phase 1)
- status: pending
- depends: 없음 (Phase 0 완료)
- scope (firm v1): `daemon/{package.json,tsconfig.json}`, `daemon/src/{config,watcher,committer,index}.ts`. watcher=chokidar v4(`ignoreInitial`, `ignored:/\.git/`, `awaitWriteFinish{2000,100}`). committer=repo-local identity 자동설정 + debounce 3s + `add -A` + `status --porcelain` empty-skip + `commit` + `push wip/<device>` + idle(`AUTOSAVE_IDLE_MS` 기본 5m)→공용 저장 시퀀스(`commit-tree -p origin/main` + `reset --soft` + `push --force-with-lease`) + 60s sync-down(`merge -X theirs`, `GIT_MERGE_AUTOEDIT=no`) + PromiseQueue 직렬화. esbuild 단일파일 번들 스크립트(`dist/index.js`).
- 자른 것: systemd 실제 등록·hermes 배포·실 접속(외부/실행).
- files: `daemon/src/*`, 참고 `server-setup/obsidian-git-sync.service`(존재), PLAN Phase 1 + "저장 플로우"/"Sync-down 플로우" 섹션.
- landmines: chokidar v4 glob 제거→명시경로+정규식 ignored; non-ff는 단일작성자 전제→log+force-with-lease(rebase 폴백 불필요); idle 타이머 매 커밋 갱신; empty-skip은 correctness(무한루프 종결자); REMOTE는 hermes 로컬경로(`~/vault.git`).
- done: `npm run build -w daemon` + `tsc --noEmit` 통과 + 임시 bare repo 스모크(파일변경→wip 커밋·푸시→idle squash→main 전진) 통과 + commit.

### 2. plugin-scaffold — 플러그인 + 자동 동기화 (PLAN Phase 2)
- status: pending
- depends: 없음
- scope (firm v1): `plugin/{manifest.json(isDesktopOnly:true),versions.json,package.json,tsconfig.json,esbuild.config.mjs,styles.css}`, `plugin/src/{main,settings}.ts`, `plugin/src/setup/SshSetup.ts`, `plugin/src/git/{GitManager,PromiseQueue}.ts`, `plugin/src/sync/AutoSync.ts`, `plugin/src/ui/StatusBar.ts`. GitManager=simple-git + `FileSystemAdapter.getBasePath()` 타입가드 + ensureRepo/commitAll/push/fetch/syncDown/squashMergeToMain/suppressEvents. AutoSync=onLayoutReady 후 vault.on 등록 + debounce + 60s fetch 사이클 1개 + suppressEvents(+2s grace) + 에디터 flush(`MarkdownView.save()`) + empty-skip. settings=deviceId 자동생성(`hostname-slug + '-' + 랜덤4자리 base36`) 영속화. SshSetup=ssh-keygen ed25519(`.obsidian/plugins/obsidian-git-sync/id_ed25519`) + `core.sshCommand`(IdentitiesOnly+accept-new) + 공개키 복사 UI.
- 자른 것: WipPanel(항목3), SaveModal(항목4), 실 Obsidian 구동.
- landmines: `vault.adapter.basePath` 직접접근 타입불가→`instanceof FileSystemAdapter`; 시작 커밋폭주→onLayoutReady; 이벤트 피드백루프→suppressEvents+empty-skip; 모든 git op PromiseQueue 직렬화.
- done: `npm run build -w plugin`(esbuild→`plugin/main.js`) + `tsc --noEmit` 통과 + commit.

### 3. wip-panel — WIP 확인 패널 (PLAN Phase 3)
- status: pending
- depends: plugin-scaffold
- scope (firm v1): `plugin/src/ui/WipPanel.ts`(ItemView, 리본 토글), AutoSync 60s fetch 사이클 공유, `for-each-ref --sort=-committerdate refs/remotes/origin` → `wip/*` 마지막 커밋 시각·작성자·요약, 비개발자 친화 문구. main.ts에 view/리본 등록 + onunload 정리.
- landmines: fetch 2번 금지(60s 사이클 공유); registerView/리본 onunload 정리.
- done: `npm run build -w plugin` + `tsc --noEmit` 통과 + commit.

### 4. save-flow — 저장(squash) 모달 (PLAN Phase 4)
- status: pending
- depends: plugin-scaffold
- scope (firm v1): `plugin/src/ui/SaveModal.ts`(리본/커맨드 "저장"→확인 모달→`GitManager.squashMergeToMain()`→진행/결과, 실패시 reflog 복구 안내). squashMergeToMain plumbing 시퀀스 구현·확정(sync-down 내장 → `TREE=HEAD^{tree}` → tree==origin/main tree면 skip → `commit-tree TREE -p origin/main` → `push $C:refs/heads/main`(non-ff 시 fetch부터 재시도 ≤3 jitter) → `reset --soft $C` → `push --force-with-lease wip`). main.ts 커맨드/리본 등록.
- landmines: checkout 없음(plumbing); `reset --soft`(하드 금지-mtime 교란); 빈 저장 방지; non-ff 재시도는 fetch/sync-down부터.
- done: `npm run build -w plugin` + `tsc --noEmit` 통과 + 임시 bare repo 스모크(양쪽 다른 줄 편집→저장→main 1커밋+union 병합+wip 리셋) 통과 + commit.

### 5. integration-docs — 통합 검증 + 온보딩 마감 (PLAN Phase 5)
- status: pending
- depends: daemon, plugin-scaffold, wip-panel, save-flow
- scope (firm v1): 루트 `npm run build` 전체 통과 확인, docs(ONBOARDING/ARCHITECTURE/CONFLICT-POLICY)·README를 실제 코드와 일치하게 보강, E2E 시나리오 3종(①동시편집→저장 ②hermes idle→사용자 sync-down ③사용자 저장→hermes sync-down) 절차 문서화(실 구동은 외부).
- 자른 것: 실 hermes/Obsidian 구동, GitHub release/PR publish(→사용자 인계).
- landmines: 실 서버·앱 구동은 destructive→절차만; 배포는 자격증명 필요→자율 금지.
- done: 루트 `npm run build` 통과 + 문서 코드 일치 + commit. 배포는 사용자 인계.

## Progress log
- (iteration마다 1줄: `YYYY-MM-DD <slug> done @<hash>` 또는 `blocker: …`)
