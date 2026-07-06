/**
 * 다중 작성자 blame 통합 테스트 (격리 temp repo, 실 GitManager + alignBlame).
 * origin/main 각 줄을 서로 다른 참여자가 커밋 → mainBlameLines 가 라인별 정확한 작성자를 주고,
 * alignBlame 이 로컬 버퍼(미저장 편집 포함)에 위치정확하게 매핑하는지 검증.
 * (T4 리뷰 지적: 단일 작성자 't' 테스트로는 위치정확성이 증명되지 않음 → 여기서 닫는다.)
 * 실행: npm run test:multiauthor -w plugin
 */
import { GitManager, type BlameLine } from '../src/git/GitManager';
import { alignBlame } from '../src/editor/blameLines';
import { relativeTime } from '../src/editor/relativeTime';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

let devN = 0;
/** 한 참여자가 고정 시각·이름으로 note.md 를 main 에 커밋/푸시. */
function commitAs(root: string, bare: string, author: string, content: string, epochSec: number): void {
  const dir = join(root, `dev-${devN++}`);
  sh('git', ['clone', '-q', bare, dir]);
  sh('git', ['-C', dir, 'config', 'user.name', author]);
  sh('git', ['-C', dir, 'config', 'user.email', `${author}@t`]);
  writeFileSync(join(dir, 'note.md'), content);
  sh('git', ['-C', dir, 'add', '-A']);
  const iso = new Date(epochSec * 1000).toISOString();
  // author date 고정 → 상대시간 결정적 (GIT_AUTHOR_DATE 로 --line-porcelain author-time 확정)
  execFileSync('git', ['-C', dir, 'commit', '-qm', `edit by ${author}`], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
  sh('git', ['-C', dir, 'push', '-qf', 'origin', 'main']);
}

const NOW_SEC = 1_751_500_000;
const NOW_MS = NOW_SEC * 1000;
const DAY = 86400;

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ogs-multi-'));
  try {
    const bare = join(root, 'wiki.git');
    sh('git', ['init', '--bare', '-b', 'main', bare]);

    // 순차 편집 — 최종 note.md 4줄의 blame 작성자 = 영희/영희/철수/민수.
    commitAs(root, bare, '영희', '# 회의록\n첫 안건.\n', NOW_SEC - 30 * DAY);
    commitAs(root, bare, '철수', '# 회의록\n첫 안건.\n철수 추가 안건.\n', NOW_SEC - 7 * DAY);
    commitAs(root, bare, '민수', '# 회의록\n첫 안건.\n철수 추가 안건.\n민수 결론.\n', NOW_SEC - 3 * 3600);

    const local = join(root, 'my-vault');
    mkdirSync(local, { recursive: true });
    const gm = new GitManager({
      basePath: local,
      authedRemote: bare,
      deviceId: '나',
      flushEditors: async () => undefined,
    });
    await gm.ensureRepo();

    const base = (await gm.mainFileContent('note.md')) ?? '';
    const blame: BlameLine[] = await gm.mainBlameLines('note.md');

    // 1) mainBlameLines 위치정확 — 라인 인덱스별 작성자 (내용 아닌 위치)
    assert(blame.length === 4, `blame 4줄 (got ${blame.length})`);
    assert(blame[0].author === '영희', 'line0 작성자 영희');
    assert(blame[1].author === '영희', 'line1 작성자 영희');
    assert(blame[2].author === '철수', 'line2 작성자 철수');
    assert(blame[3].author === '민수', 'line3 작성자 민수');
    const distinct = new Set(blame.map((b) => b.author));
    assert(distinct.size === 3, `작성자 3명 (got ${[...distinct].join(',')})`);

    // 2) 상대시간 결정적 (author-time 고정)
    assert(relativeTime(blame[2].epoch, NOW_MS) === '1주 전', `철수 줄 상대시간 1주 전`);
    assert(relativeTime(blame[3].epoch, NOW_MS) === '3시간 전', `민수 줄 상대시간 3시간 전`);

    // 3) alignBlame — 내 미저장 편집(맨 끝 한 줄 추가) → 그 줄만 null, 나머지 유지
    const bufAppend = base.replace(/\n$/, '') + '\n내 미저장 메모.\n';
    const aAppend = alignBlame(base, bufAppend, blame);
    assert(aAppend.length === 5, `append 후 5줄 (got ${aAppend.length})`);
    assert(aAppend[3]?.author === '민수', 'append: 민수 줄 유지');
    assert(aAppend[4] === null, 'append: 내 미저장 줄 빈칸(null)');

    // 4) 위치정확 결정타 — 중간 삽입: 삽입 줄 null, 그 아래 철수/민수 작성자가 인덱스 밀려서도 유지
    //    (내용 기반 매핑이면 여기서 틀린다.)
    const bufInsert = '# 회의록\n첫 안건.\n삽입한 줄.\n철수 추가 안건.\n민수 결론.\n';
    const aInsert = alignBlame(base, bufInsert, blame);
    assert(aInsert.length === 5, `insert 후 5줄 (got ${aInsert.length})`);
    assert(aInsert[0]?.author === '영희' && aInsert[1]?.author === '영희', 'insert: 상단 영희 유지');
    assert(aInsert[2] === null, 'insert: 삽입 줄 빈칸(null)');
    assert(aInsert[3]?.author === '철수', 'insert: 철수 줄이 인덱스 3으로 밀려도 작성자 유지');
    assert(aInsert[4]?.author === '민수', 'insert: 민수 줄이 인덱스 4로 밀려도 작성자 유지');

    console.log('multiAuthorBlame: 전부 통과');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
