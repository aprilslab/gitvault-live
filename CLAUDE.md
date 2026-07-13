# CLAUDE.md

> 이 파일은 프롬프트에 포함된다 — 한 줄 = 한 개념, 간결 유지. 상세 설계는 `README.md` / `docs/*` 참조(중복 금지).

## 무엇

Obsidian vault(=git repo 1:1)를 순수 git 으로 동기화. 대상=git 비개발자. SoT=호스팅 git repo `main`. 벤더 API 안 씀. 전체 그림은 [`README.md`](./README.md), 아키텍처 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), 충돌정책 [`docs/CONFLICT-POLICY.md`](./docs/CONFLICT-POLICY.md).

## 레이아웃 (npm workspaces: `plugin`, `daemon`)

- `plugin/` — Obsidian 데스크톱 플러그인. git 로직 `plugin/src/git/GitManager.ts`, UI `plugin/src/ui/`, `plugin/src/main.ts`.
- `daemon/` — 헤드리스 git 클라이언트(에이전트/서버용). 핵심 `daemon/src/committer.ts`.
- `templates/` — vault 에 심는 seed(`vault.gitattributes` union, `vault.gitignore`).
- `install.sh` (Linux/macOS), `install.ps1` (Windows), `README.md`, `docs/`.

## ⚠️ Parity 규약 (이 repo 제1원칙)

`plugin` 과 `daemon` 은 **같은 git 불변식을 각자 중복 구현**한다(공유 vault·.git 을 교대로 소유). 한쪽 로직을 바꾸면 **반드시 다른 쪽·README·templates 를 함께** 맞춰라. 과거 data.json 팀원 덮어쓰기 버그가 이 drift 에서 나왔다.

| 불변식 | `plugin/src/git/GitManager.ts` | `daemon/src/committer.ts` |
|--------|-------------------------------|---------------------------|
| seed(.gitattributes union) | `seedRepoFiles` | `seedRepoFiles` |
| `.gitignore` `.obsidian/` 보장 | `ensureGitignoreRules` | `ensureGitignoreRules`(포팅본) |
| `.obsidian` untrack(인덱스) | `git rm -r --cached .obsidian` | 〃 (ensureRepo 내) |
| union merge(.md), non-md=theirs | mergeDown | mergeDown |
| push=일반 ff (force 금지) | `push … HEAD:refs/heads/main` | 〃 |
| device 식별 | deviceId | deviceId |

**로직·문구·seed 규칙 변경 시 체크:** committer.ts / GitManager.ts / README.md / templates/ / 양쪽 테스트.

## 빌드·테스트·타입체크

- `npm run build` — 워크스페이스 전체. `npm run build -w plugin` 은 `plugin/main.js` + 번들 `plugin/daemon.js`(= `../daemon/src/index.ts` 에서 빌드) 생성. `-w daemon` 은 `daemon/dist/index.js`.
- 테스트: `npm test -w plugin` (esbuild 번들→node), `npm run smoke -w daemon` (임시 bare repo + 실제 git 시퀀스). 타입: `npm run typecheck -w plugin|daemon`.
- 새 순수함수는 `plugin/test/<name>.test.ts` 추가 + `package.json` `test:<name>` 등록 + `test` 체인에 연결. git 시퀀스 회귀는 `daemon/test/smoke.ts` 에 시나리오 추가.

## 불변식·함정

- **`.obsidian/`·`data.json` 은 절대 추적 금지** — data.json 에 기기별 deviceId·평문 토큰. 추적되면 팀원끼리 서로 덮어씀. `.gitignore` 에 두 규칙 이미 있음.
- **force push 없음.** non-ff 는 `fetch → union merge → 재시도`. protected `main` 이 직접 push 를 막으면 이 도구 자체가 동작 못 함(PR 워크플로와 근본 충돌).
- push 실패는 daemon 로그(`journalctl`/`/tmp/ogs-daemon-*.log`)에만 찍힘 — UI 로 안 올라옴(조용한 실패).
- 빌드 산출물(`main.js`, `plugin/daemon.js`, `daemon/dist/`)은 gitignore. 소스만 커밋.
- **원라이너(`curl … | bash`)는 공개 github `aprilslab/gitvault-live` `main` 을 clone·빌드** — 로컬 미커밋 fix 는 안 나감. 배포하려면 먼저 `main` 에 push. repo 안에서 `./install.sh` 실행 시엔 로컬 소스 사용.

## 배포(수동 갱신)

- 데스크톱 플러그인: `plugin/{main.js,daemon.js}` 를 각 vault `.obsidian/plugins/gitvault-live/` 로 복사(data.json·manifest·styles 는 유지) → Obsidian 플러그인 리로드 필요(코드 반영).
- 로컬 daemon(macOS launchd): `~/Library/Application Support/gitvault-live/daemon.js` 교체 후 `launchctl kickstart -k gui/$UID/com.gitvault-live.<name>`.
- 서버 daemon(systemd): `daemon/dist/index.js` → `/opt/gitvault-live/daemon.js` 복사 후 `sudo systemctl restart gitvault-live@<name>`.

## 커밋

`<type>: <설명>` (feat/fix/refactor/docs/test/chore). 논리단위 분리. 첨부(attribution) 전역 비활성.
