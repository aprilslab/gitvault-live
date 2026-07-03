/**
 * diffLines 단위 테스트 (순수 함수 — Obsidian/CM/git 비의존).
 * hunk 의미론이 `git diff -U0`(parseUnifiedHunks 출력)과 일치하는지 교차 검증한다.
 * 실행: npm run test:linediff -w plugin
 */
import { diffLines } from '../src/editor/lineDiff';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

// 1) 동일 입력 → 빈 배열
assert(diffLines('a\nb\n', 'a\nb\n').length === 0, '동일 입력 = 빈 배열');
assert(diffLines('', '').length === 0, '빈 파일 = 빈 배열');

// 2) 말단 개행 정규화 — git 라인 의미론(개행은 구분자)과 CM 버퍼(말단 개행 없음) 정합
assert(diffLines('a\n', 'a').length === 0, "'a\\n' vs 'a' 동등");

// 3) 순수 추가 (diffHunks.test h1 과 동일 의미론: @@ -2,0 +3,1 @@)
{
  const h = diffLines('l1\nl2\n', 'l1\nl2\nadded line\n');
  assert(h.length === 1, '순수 추가 hunk 1개');
  assert(h[0].newStart === 3 && h[0].newCount === 1, '추가 newStart=3/newCount=1');
  assert(h[0].addedCount === 1 && h[0].removedLines.length === 0, '추가 added=1, removed=0');
}

// 4) 엔터만 입력(빈 줄 추가) — 사용자가 보고한 "엔터 인식 안 됨" 회귀 고정
{
  const h = diffLines('a\nb\n', 'a\n\nb\n');
  assert(h.length === 1 && h[0].newStart === 2 && h[0].newCount === 1, '빈 줄 추가 = hunk 1개(newStart 2)');
}

// 5) 순수 삭제 중간 (diffHunks.test h2 와 동일 의미론: @@ -3,2 +2,0 @@)
{
  const h = diffLines('l1\nl2\ngone one\ngone two\nl5\n', 'l1\nl2\nl5\n');
  assert(h.length === 1 && h[0].newCount === 0, '순수 삭제 newCount=0');
  assert(h[0].newStart === 2, '삭제 앵커 = 직전 라인(2)');
  assert(
    h[0].removedLines.length === 2 && h[0].removedLines[0] === 'gone one' && h[0].removedLines[1] === 'gone two',
    '삭제 라인 원문 보존',
  );
}

// 6) 맨 앞 삭제 → newStart 0 (CollabDecorations 의 clamp 계약)
{
  const h = diffLines('gone\nl1\n', 'l1\n');
  assert(h.length === 1 && h[0].newStart === 0 && h[0].newCount === 0, '맨 앞 삭제 newStart=0');
}

// 7) 치환 (diffHunks.test h3 과 동일 의미론: @@ -2,1 +2,1 @@)
{
  const h = diffLines('l1\nold text\nl3\n', 'l1\nnew text\nl3\n');
  assert(h.length === 1 && h[0].newStart === 2 && h[0].newCount === 1, '치환 newStart/newCount');
  assert(h[0].addedCount === 1 && h[0].removedLines[0] === 'old text', '치환 added=1, removed=old text');
}

// 8) 떨어진 변경 두 곳 → hunk 2개
{
  const h = diffLines('a\nb\nc\nd\ne\nf\n', 'a\nB\nc\nd\nE\nf\n');
  assert(h.length === 2, '분리된 변경 = hunk 2개');
  assert(h[0].newStart === 2 && h[1].newStart === 5, `각 hunk 위치 (${h[0].newStart},${h[1].newStart})`);
}

// 9) 빈 파일 ↔ 내용
{
  const add = diffLines('', 'x\n');
  assert(add.length === 1 && add[0].newStart === 1 && add[0].newCount === 1, '빈→내용 = 추가 hunk');
  const del = diffLines('x\n', '');
  assert(del.length === 1 && del[0].newStart === 0 && del[0].newCount === 0, '내용→빈 = 삭제 hunk(앵커 0)');
}

// 10) 대형 입력 폴백 (중앙부 n*m > 1e6) — 단일 replace hunk, 시간 상한 보장
{
  const N = 1100;
  const oldBig = Array.from({ length: N }, (_, i) => `o${i}`).join('\n') + '\n';
  const newBig = Array.from({ length: N }, (_, i) => `n${i}`).join('\n') + '\n';
  const t0 = Date.now();
  const h = diffLines(oldBig, newBig);
  assert(h.length === 1 && h[0].newCount === N && h[0].removedLines.length === N, '대형 입력 = 단일 폴백 hunk');
  assert(Date.now() - t0 < 1_000, '폴백 경로 1초 미만');
}

// 11) 대형이어도 국소 변경이면 트림 후 정밀 diff (폴백 아님)
{
  const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
  const oldBig = lines.join('\n') + '\n';
  const edited = [...lines];
  edited[25_000] = 'EDITED';
  const h = diffLines(oldBig, edited.join('\n') + '\n');
  assert(h.length === 1 && h[0].newStart === 25_001 && h[0].newCount === 1, '5만 라인 중 1곳 편집 = 정밀 hunk');
}

console.log('LINEDIFF OK');
