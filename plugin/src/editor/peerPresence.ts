/**
 * 타 참여자 wip 내용 vs 내 버퍼 → "작성 중" presence 훅.
 * 각 peer 가 썼고 내 버퍼에 없는 줄을 pure-presence 훅(newCount=0, removedLines, author)으로 —
 * CollabDecorations.build() 의 presence-배지 분기만 트리거(라인 하이라이트 분기는 newCount>0 이라 안 탐).
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
  buffer: string,
): DiffHunk[] {
  const out: DiffHunk[] = [];
  for (const peer of peers) {
    // diffLines(old=peer, new=buffer): removedLines = peer 엔 있고 버퍼엔 없는 줄(그가 작성 중)
    for (const h of diffLines(peer.content, buffer)) {
      if (h.removedLines.length === 0) continue; // 순수 추가(내 편집)은 presence 아님
      out.push({
        newStart: h.newStart, // 버퍼 기준 앵커
        newCount: 0, // pure-presence — 하이라이트 분기 회피
        addedCount: 0,
        removedLines: h.removedLines,
        author: peer.author,
      });
    }
  }
  return out;
}
