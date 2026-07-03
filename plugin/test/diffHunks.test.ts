/**
 * parseUnifiedHunks 단위 테스트 (순수 함수 — Obsidian/CM 비의존).
 * 실행: npm run test:hunks -w plugin
 */
import { parseUnifiedHunks } from '../src/editor/diffHunks';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

const DIFF = [
  'diff --git a/note.md b/note.md',
  'index abc1234..def5678 100644',
  '--- a/note.md',
  '+++ b/note.md',
  '@@ -2,0 +3,1 @@ some section',
  '+added line',
  '@@ -5,2 +6,0 @@',
  '-gone one',
  '-gone two',
  '@@ -8,1 +8,1 @@',
  '-old text',
  '+new text',
  '',
].join('\n');

const hunks = parseUnifiedHunks(DIFF);
assert(hunks.length === 3, `hunk 3개 (got ${hunks.length})`);

// 1) 순수 추가(내 편집)
assert(hunks[0].newStart === 3 && hunks[0].newCount === 1, 'h1 newStart/newCount');
assert(hunks[0].addedCount === 1 && hunks[0].removedLines.length === 0, 'h1 added=1, removed=0');

// 2) 순수 삭제(도착 예정 incoming) — newCount 0, removedLines 채워짐
assert(hunks[1].newStart === 6 && hunks[1].newCount === 0, 'h2 newStart/newCount=0');
assert(
  hunks[1].removedLines.length === 2 &&
    hunks[1].removedLines[0] === 'gone one' &&
    hunks[1].removedLines[1] === 'gone two',
  'h2 removedLines 2개 원문',
);

// 3) 수정(양쪽)
assert(hunks[2].newStart === 8 && hunks[2].newCount === 1, 'h3 newStart/newCount');
assert(
  hunks[2].addedCount === 1 && hunks[2].removedLines[0] === 'old text',
  'h3 added=1, removed=old text',
);

// 헤더뿐(변경 없음) → 빈 배열
assert(parseUnifiedHunks('diff --git a/x b/x\nindex 0..0\n--- a/x\n+++ b/x\n').length === 0, '변경없음=빈 배열');
assert(parseUnifiedHunks('').length === 0, '빈 입력=빈 배열');

// 회귀: 본문의 '---'/'-- ' 삭제 라인이 파일 헤더로 오분류되지 않아야 함 (YAML fence/구분선)
const FENCE = ['--- a/n.md', '+++ b/n.md', '@@ -1,2 +0,0 @@', '----', '-- note', ''].join('\n');
const fh = parseUnifiedHunks(FENCE);
assert(fh.length === 1 && fh[0].newCount === 0, 'fence hunk 1개, 순수삭제');
assert(
  fh[0].removedLines.length === 2 && fh[0].removedLines[0] === '---' && fh[0].removedLines[1] === '- note',
  "본문 '---'/'-- note' 삭제 라인 보존",
);

console.log('HUNKS OK');
