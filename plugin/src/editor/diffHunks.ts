/**
 * unified diff(`git diff -U0 origin/main -- <file>`) → hunk 목록 파서.
 * origin/main(old) 대비 로컬 워킹트리(new)의 차이를 라인 단위로 표현한다.
 * 순수 함수 — Obsidian/CM 비의존, 단위 테스트 대상.
 */
export interface DiffHunk {
  /** 새 파일(로컬 워킹트리) 기준 시작 라인 (1-based). */
  newStart: number;
  /** 새 파일에서 이 hunk 가 차지하는 라인 수. 0 이면 순수 삭제(=로컬에 없는 incoming). */
  newCount: number;
  /** 로컬에만 있는(내 편집) 라인 수. */
  addedCount: number;
  /** origin/main 에만 있는(로컬에 없는) 라인들 = 도착 예정 내용. */
  removedLines: string[];
  /** 이 incoming hunk 를 작성한 참여자(blame 으로 채움). 없으면 undefined. */
  author?: string;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;

  for (const line of diff.split('\n')) {
    const m = HUNK_RE.exec(line);
    if (m) {
      cur = {
        newStart: Number(m[1]),
        newCount: m[2] === undefined ? 1 : Number(m[2]),
        addedCount: 0,
        removedLines: [],
      };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // 헤더(diff/index/---/+++)는 첫 @@ 이전(cur=null)이라 여기 안 옴
    // hunk 본문: 단일 선두 문자로만 분류. 본문 내용이 '---'/'+++'(예: YAML fence, 구분선)여도
    // '----'/'+++' 로 나타나므로 startsWith('---') 가드를 쓰면 오분류된다 → 쓰지 않는다.
    if (line.startsWith('+')) {
      cur.addedCount++;
    } else if (line.startsWith('-')) {
      cur.removedLines.push(line.slice(1));
    }
  }
  return hunks;
}
