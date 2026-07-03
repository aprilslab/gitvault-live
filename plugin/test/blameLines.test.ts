/**
 * alignBlame 단위 테스트 (순수 — git/CM 비의존).
 * 실행: npm run test:blame -w plugin
 */
import { alignBlame } from '../src/editor/blameLines';
import type { BlameLine } from '../src/git/GitManager';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}
const bl = (author: string): BlameLine => ({ author, epoch: 1_700_000_000 });

// 1) 무변경 → 전 줄 origin 작성자 그대로
{
  const old = 'a\nb\nc\n';
  const authors = [bl('영희'), bl('철수'), bl('영희')];
  const out = alignBlame(old, old, authors);
  assert(out.length === 3, '길이 3');
  assert(out[0]?.author === '영희' && out[1]?.author === '철수' && out[2]?.author === '영희', '무변경 매핑');
}

// 2) 중간 삽입 → 삽입 줄만 null, 나머지 유지
{
  const old = 'a\nb\n';
  const neu = 'a\nX\nb\n';
  const out = alignBlame(old, neu, [bl('영희'), bl('철수')]);
  assert(out.length === 3, '삽입 후 길이 3');
  assert(out[0]?.author === '영희', 'a 유지');
  assert(out[1] === null, '삽입 X → null(미저장)');
  assert(out[2]?.author === '철수', 'b 유지');
}

// 3) 삭제 → new 에 그 줄 없음, 남은 줄 작성자 유지
{
  const old = 'a\nb\nc\n';
  const neu = 'a\nc\n';
  const out = alignBlame(old, neu, [bl('영희'), bl('철수'), bl('민수')]);
  assert(out.length === 2, '삭제 후 길이 2');
  assert(out[0]?.author === '영희' && out[1]?.author === '민수', 'a,c 작성자 유지');
}

// 4) 치환 → 바뀐 줄 null
{
  const out = alignBlame('a\nb\nc\n', 'a\nB\nc\n', [bl('영희'), bl('철수'), bl('민수')]);
  assert(out[0]?.author === '영희' && out[1] === null && out[2]?.author === '민수', '치환 줄 null');
}

// 5) origin 빈(신규 노트) → 전부 null
{
  const out = alignBlame('', 'a\nb\n', []);
  assert(out.length === 2 && out[0] === null && out[1] === null, '신규 노트 전부 null');
}

// 6) 중복 줄 — 위치 정확(내용 아님)
{
  const out = alignBlame('x\nx\n', 'x\nx\n', [bl('영희'), bl('철수')]);
  assert(out[0]?.author === '영희' && out[1]?.author === '철수', '중복 줄도 위치별 작성자');
}

console.log('alignBlame: 전부 통과');
