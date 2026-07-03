/**
 * 인메모리 라인 diff: origin/main 파일 내용(old) vs 에디터 버퍼(new) → DiffHunk[].
 * `git diff -U0` 와 동일한 hunk 의미론 (parseUnifiedHunks 출력과 호환) —
 * CollabDecorations.build() 를 무변경으로 재사용하기 위한 계약이다.
 * 순수 함수 — Obsidian/CM/git 비의존, 단위 테스트 대상.
 */
import type { DiffHunk } from './diffHunks';

/** LCS DP 셀 수 상한. 초과 시 단일 replace hunk 폴백 — 대형 문서에서도 선형 시간 보장. */
const MAX_DP_CELLS = 1_000_000;

export function diffLines(oldText: string, newText: string): DiffHunk[] {
  const a = toLines(oldText);
  const b = toLines(newText);

  // 공통 prefix/suffix 트림 — 일반 편집(국소 변경)에서 DP 대상을 최소화한다.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return [];

  if (midA.length * midB.length > MAX_DP_CELLS) {
    // 폴백: 중앙부 전체를 단일 replace hunk 로 — 정밀도만 낮아지고 기능은 유지.
    return [runHunk(start, midB.length, midA)];
  }
  return buildHunks(lcsOps(midA, midB), midA, start);
}

/** git 라인 의미론: 말단 개행 1개는 라인 구분자(빈 마지막 라인 아님). */
function toLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = 0 | 1 | 2; // 0 '='(공통) | 1 '-'(old 전용) | 2 '+'(new 전용)

/** 표준 LCS DP + 역추적 → op 시퀀스 (앞→뒤 순서). */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * w + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * w + (j - 1)] + 1
          : Math.max(dp[(i - 1) * w + j], dp[i * w + (j - 1)]);
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push(0);
      i--;
      j--;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + (j - 1)]) {
      ops.push(1);
      i--;
    } else {
      ops.push(2);
      j--;
    }
  }
  while (i > 0) {
    ops.push(1);
    i--;
  }
  while (j > 0) {
    ops.push(2);
    j--;
  }
  return ops.reverse();
}

/** 연속 변경 run 을 hunk 로 묶는다. offset = 트림된 공통 prefix 라인 수. */
function buildHunks(ops: Op[], a: string[], offset: number): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let ai = 0; // old 중앙부 인덱스
  let bj = 0; // new 중앙부 인덱스
  let k = 0;
  while (k < ops.length) {
    if (ops[k] === 0) {
      ai++;
      bj++;
      k++;
      continue;
    }
    const removed: string[] = [];
    const jStart = bj;
    let added = 0;
    while (k < ops.length && ops[k] !== 0) {
      if (ops[k] === 1) {
        removed.push(a[ai++]);
      } else {
        added++;
        bj++;
      }
      k++;
    }
    hunks.push(runHunk(offset + jStart, added, removed));
  }
  return hunks;
}

/**
 * -U0 hunk 의미론: 추가가 있으면 newStart = 새 파일 기준 첫 변경 라인(1-based),
 * 순수 삭제면 newStart = 삭제 지점 직전 라인(맨 앞 삭제 = 0), newCount = 0.
 * jStart0 = 새 파일 기준 변경 시작점의 0-based 라인 인덱스.
 */
function runHunk(jStart0: number, added: number, removed: string[]): DiffHunk {
  return added > 0
    ? { newStart: jStart0 + 1, newCount: added, addedCount: added, removedLines: removed }
    : { newStart: jStart0, newCount: 0, addedCount: 0, removedLines: removed };
}
