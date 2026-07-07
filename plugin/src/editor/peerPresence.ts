/**
 * 타 참여자 wip 내용 vs 공유 base(origin/main) → "작성 중" presence 훅.
 * 각 peer 가 base 대비 추가로 쓴 줄을 pure-presence 훅(newCount=0, removedLines, author)으로 —
 * CollabDecorations.build() 의 presence-배지 분기만 트리거(라인 하이라이트 분기는 newCount>0 이라 안 탐).
 *
 * [CRITICAL] 두 번째 인자는 "내 에디터 버퍼"가 아니라 "공유 base(origin/main 내용)"여야 한다. 버퍼를 기준
 * 삼으면, 내가 origin/main 에 있는 줄(예: "abc")을 "abc-xyz" 로 편집하는 중일 때 peer 의 사본은 여전히
 * "abc" 를 갖고 있어 diff(peer, buffer) 의 removedLines 에 "abc" 가 잡혀 peer 가 "작성 중"인 것처럼 오탐된다
 * — 실제로는 내가 편집 중인 내용이 peer 것으로 잘못 표시되는 것. base 기준으로 diff 하면 peer 가 base 대비
 * 실제로 추가한 줄만 나오므로, 내 버퍼가 무엇이든(base 대비 어떻게 갈라졌든) peer 배지에 영향을 주지 않는다.
 *
 * 순수 — git/CM 비의존. staleness 판정 포함.
 */
import type { DiffHunk } from './diffHunks';
import { diffLines } from './lineDiff';

const PEER_WIP_STALE_MS = 5 * 60 * 1000;

export function isStalePeer(commitEpochSec: number, nowMs: number): boolean {
  return nowMs - commitEpochSec * 1000 > PEER_WIP_STALE_MS;
}

export function mergePeerHunks(
  peers: readonly { author: string; content: string }[],
  base: string,
): DiffHunk[] {
  const out: DiffHunk[] = [];
  for (const peer of peers) {
    // diffLines(old=peer, new=base): removedLines = peer 엔 있고 base 엔 없는 줄
    // = peer 가 공유 base 대비 실제로 추가/작성 중인 내용(내 버퍼와 무관 — 오탐 원천 차단).
    for (const h of diffLines(peer.content, base)) {
      if (h.removedLines.length === 0) continue; // 순수 추가(peer 가 base 의 내용을 지운 쪽)은 presence 아님
      out.push({
        newStart: h.newStart, // base 기준 앵커
        newCount: 0, // pure-presence — 하이라이트 분기 회피
        addedCount: 0,
        removedLines: h.removedLines,
        author: peer.author,
      });
    }
  }
  return out;
}
