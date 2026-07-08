# Contributing

기여 환영. 버그 리포트·기능 제안은 이슈로, 코드는 PR 로.

## 개발 환경

- Node 18+, git CLI
- npm workspaces 모노레포: `plugin/`(Obsidian 플러그인) + `daemon/`(헤드리스 git 클라이언트)

```bash
git clone https://github.com/<owner>/gitvault-live.git
cd gitvault-live
npm install
npm run build          # plugin + daemon 빌드
```

## 검증 (PR 전 필수)

```bash
npm run build                 # 타입 포함 빌드 통과
npm run test -w plugin        # 플러그인 유닛/통합 스위트
npm run smoke -w daemon       # daemon 실제 git 시퀀스 스모크
cd daemon && npm run typecheck && cd ..
```

전부 초록이어야 함. 동작 변경엔 회귀 테스트를 함께 추가한다(`plugin/test/*`, `daemon/test/smoke.ts` 참고).

## 로컬에서 실 Obsidian 검증

```bash
npm run build
# 산출물 복사:
#   plugin/{main.js,manifest.json,styles.css} → <test-vault>/.obsidian/plugins/gitvault-live/
```

테스트는 **버릴 수 있는 별도 vault** 로. 실제 노트 vault 에 붙이지 말 것. LiveSync·Obsidian Sync 등 다른 동기화와 병행 금지.

## 코드 스타일

- TypeScript strict. `any` 지양, 경계에서 검증.
- 작은 파일·단일 책임. 불변 패턴 선호.
- git op 은 항상 `PromiseQueue` 로 직렬화(`.git/index.lock` 충돌 방지).
- **데이터 손실 위험 영역**(merge/checkout/reset)은 리뷰에서 특히 엄격 — 워킹트리 파괴(`reset --hard`/`checkout -f`) 금지, `symbolic-ref`+`reset --mixed` 패턴 사용.

## 커밋 / PR

- 커밋: `<type>: <설명>` (feat/fix/refactor/docs/test/chore). 본문에 "왜".
- PR: 변경 요약 + 테스트 방법. CI(빌드+테스트+스모크)가 통과해야 머지.

## 설계 이해

동기화·충돌·브랜치 모델은 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), 충돌 정책은 [`docs/CONFLICT-POLICY.md`](./docs/CONFLICT-POLICY.md).
