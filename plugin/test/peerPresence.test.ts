/**
 * mergePeerHunks/isStalePeer 단위 테스트 (순수).
 * mergePeerHunks 의 두 번째 인자는 "내 버퍼"가 아니라 공유 base(origin/main 내용)다 — 그래야 내가 편집
 * 중인 줄이 peer 의 "작성 중" 배지로 오탐되지 않는다(Bug B 회귀 고정, 아래 마지막 블록 참고).
 * 실행: npm run test:peer -w plugin
 */
import { mergePeerHunks, isStalePeer } from '../src/editor/peerPresence';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

// 1) 단일 peer 가 base 에 없는 줄 추가 → presence 훅 1개(author 부착, newCount=0)
{
  const base = 'a\nb\n';
  const hunks = mergePeerHunks([{ author: '영희', content: 'a\nb\n영희 줄\n' }], base);
  assert(hunks.length >= 1, 'presence 훅 생성');
  const h = hunks.find((x) => x.removedLines.some((l) => l.includes('영희 줄')));
  assert(!!h, '영희 줄이 removedLines 에');
  assert(h!.author === '영희', 'author=영희');
  assert(h!.newCount === 0, 'pure-presence(newCount=0)');
}

// 2) 다중 peer → 각 author 훅
{
  const base = 'a\n';
  const hunks = mergePeerHunks(
    [
      { author: '영희', content: 'a\n영희\n' },
      { author: '철수', content: 'a\n철수\n' },
    ],
    base,
  );
  const authors = new Set(hunks.map((h) => h.author));
  assert(authors.has('영희') && authors.has('철수'), '두 author 모두 표시');
}

// 3) peer 내용 == base → 훅 없음
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

// --- [CRITICAL] Bug B 회귀: presence 는 base(origin/main) 기준이지 내 버퍼 기준이 아니다 ---
// peer 는 아직 base 를 그대로 갖고 있고(a/b/c 그대로), base 에 없는 자기만의 줄("철수줄")을 하나 추가했다.
// mergePeerHunks 시그니처엔 "내 버퍼"가 아예 없으므로 — 내가 a/b/c 중 아무 줄을 어떻게 편집 중이든(버퍼가
// base 와 얼마나 갈라졌든) peer 훅 계산 자체가 그 사실을 볼 수 없다. 이를 "base 의 미변경 줄은 peer 가
// 손대지 않은 이상 절대 훅으로 나오지 않는다"로 검증한다 — 내 편집 오탐이 구조적으로 불가능함을 증명.
{
  const base = 'a\nb\nc\n';
  const peerContent = 'a\nb\nc\n철수줄\n'; // peer 가 base 대비 실제로 추가한 내용(a/b/c 는 그대로)
  const hunks = mergePeerHunks([{ author: '철수', content: peerContent }], base);

  // peer 가 base 대비 실제로 추가한 내용만 정확히 훅 하나로, author=철수
  const added = hunks.filter((h) => h.removedLines.some((l) => l.includes('철수줄')));
  assert(added.length === 1, '철수가 base 대비 추가한 줄만 정확히 훅 1개로');
  assert(added[0].author === '철수', 'author=철수');
  assert(added[0].newCount === 0, '추가 훅도 pure-presence(newCount=0)');

  // base 의 기존 줄(a/b/c)은 peer 가 안 건드렸으므로 어떤 훅에도 등장하지 않는다 — 이 줄들이 "내 버퍼"에서
  // 편집 중이었다 해도(시그니처에 버퍼가 없으니 그런 정보 자체가 입력되지 않는다) 결과는 동일하다.
  const touchesUnchangedBaseLine = hunks.some((h) => h.removedLines.some((l) => l === 'a' || l === 'b' || l === 'c'));
  assert(!touchesUnchangedBaseLine, 'base 미변경 줄은 훅 없음 — 내 버퍼 편집과 무관하게 항상 성립(오탐 불가)');
}

console.log('peerPresence: 전부 통과');
