/**
 * mergePeerHunks/isStalePeer 단위 테스트 (순수).
 * 실행: npm run test:peer -w plugin
 */
import { mergePeerHunks, isStalePeer } from '../src/editor/peerPresence';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

// 1) 단일 peer 가 버퍼에 없는 줄 추가 → presence 훅 1개(author 부착, newCount=0)
{
  const buffer = 'a\nb\n';
  const hunks = mergePeerHunks([{ author: '영희', content: 'a\nb\n영희 줄\n' }], buffer);
  assert(hunks.length >= 1, 'presence 훅 생성');
  const h = hunks.find((x) => x.removedLines.some((l) => l.includes('영희 줄')));
  assert(!!h, '영희 줄이 removedLines 에');
  assert(h!.author === '영희', 'author=영희');
  assert(h!.newCount === 0, 'pure-presence(newCount=0)');
}

// 2) 다중 peer → 각 author 훅
{
  const buffer = 'a\n';
  const hunks = mergePeerHunks(
    [
      { author: '영희', content: 'a\n영희\n' },
      { author: '철수', content: 'a\n철수\n' },
    ],
    buffer,
  );
  const authors = new Set(hunks.map((h) => h.author));
  assert(authors.has('영희') && authors.has('철수'), '두 author 모두 표시');
}

// 3) peer 내용 == 버퍼 → 훅 없음
{
  const hunks = mergePeerHunks([{ author: '영희', content: 'a\nb\n' }], 'a\nb\n');
  assert(hunks.length === 0, '동일 내용 → presence 없음');
}

// 4) staleness
{
  const nowMs = 1_000_000_000_000;
  assert(isStalePeer(nowMs / 1000 - 10, nowMs) === false, '10초 전 → 안 stale');
  assert(isStalePeer(nowMs / 1000 - 600, nowMs) === true, '10분 전 → stale');
}

console.log('peerPresence: 전부 통과');
