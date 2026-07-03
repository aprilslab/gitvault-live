/**
 * 버퍼 각 줄에 origin/main 작성자를 정렬한다.
 * 공통 줄 = origin 작성자, 삽입/치환 줄 = null(미저장). 위치 정확(중복 줄 안전).
 * lineDiff.alignLines(트림+폴백+LCS) 재사용 — 대형 문서 안전. 순수 — git/CM 비의존.
 */
import type { BlameLine } from '../git/GitManager';
import { alignLines, toLines } from './lineDiff';

export function alignBlame(
  oldText: string,
  newText: string,
  oldAuthors: readonly (BlameLine | null)[],
): (BlameLine | null)[] {
  const a = toLines(oldText);
  const b = toLines(newText);
  const out: (BlameLine | null)[] = new Array(b.length).fill(null);
  const ops = alignLines(a, b);
  let ai = 0;
  let bj = 0;
  for (const op of ops) {
    if (op === 0) {
      out[bj] = oldAuthors[ai] ?? null;
      ai++;
      bj++;
    } else if (op === 1) {
      ai++; // old 전용 — new 줄 없음
    } else {
      bj++; // new 전용(삽입) — out 이미 null
    }
  }
  return out;
}
