/**
 * 다중 device 실시간 작성중 E2E: dev-B 가 wip 편집(미저장) → dev-A 가 listPeerWips/peerWipContent
 * → mergePeerHunks 로 "영희 작성중" 훅 → dev-B 저장 → wip 삭제 → presence 소멸 + origin main 반영.
 * 실행: npm run test:peerwip -w plugin
 */
import { GitManager } from '../src/git/GitManager';
import { mergePeerHunks } from '../src/editor/peerPresence';
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
function newManager(basePath: string, remote: string, deviceId: string, displayName: string): GitManager {
  return new GitManager({ basePath, authedRemote: remote, deviceId, displayName, flushEditors: async () => undefined });
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ogs-peerwip-'));
  try {
    const bare = join(root, 'wiki.git');
    sh('git', ['init', '--bare', '-b', 'main', bare]);
    // 원격 main 부트스트랩
    const seed = join(root, 'seed');
    sh('git', ['clone', '-q', bare, seed]);
    sh('git', ['-C', seed, 'config', 'user.name', 'seed']);
    sh('git', ['-C', seed, 'config', 'user.email', 's@t']);
    writeFileSync(join(seed, 'note.md'), '공용 문서\n');
    sh('git', ['-C', seed, 'add', '-A']);
    sh('git', ['-C', seed, 'commit', '-qm', 'seed']);
    sh('git', ['-C', seed, 'push', '-q', 'origin', 'main']);

    // dev-B: 편집 → wip push (미저장)
    const bLocal = join(root, 'devB');
    mkdirSync(bLocal, { recursive: true });
    const gmB = newManager(bLocal, bare, 'dev-B', '영희');
    await gmB.ensureRepo();
    writeFileSync(join(bLocal, 'note.md'), '공용 문서\n영희가 쓰는 중\n');
    await gmB.commitAndPushWip();

    // dev-A: peer 인식 → presence 훅
    const aLocal = join(root, 'devA');
    mkdirSync(aLocal, { recursive: true });
    const gmA = newManager(aLocal, bare, 'dev-A', '철수');
    await gmA.ensureRepo();
    let peers = await gmA.listPeerWips();
    assert(peers.length === 1 && peers[0].author === '영희', 'dev-A 가 영희 wip 인식');
    const content = await gmA.peerWipContent(peers[0].ref, 'note.md');
    const myBase = '공용 문서\n'; // origin/main 내용(=dev-A 가 아직 원본) — mergePeerHunks 2번째 인자는 base
    const hunks = mergePeerHunks([{ author: peers[0].author, content: content ?? '' }], myBase);
    assert(hunks.some((h) => h.author === '영희' && h.removedLines.some((l) => l.includes('영희가 쓰는 중'))), '영희 작성중 훅 표시');

    // dev-B 저장 → wip 삭제 → dev-A presence 소멸 + main 반영
    const save = await gmB.squashMergeToMain();
    assert(save === 'saved', 'dev-B 저장 saved');
    await gmA.ensureRepo(); // 재fetch(prune)
    peers = await gmA.listPeerWips();
    assert(peers.length === 0, '저장 후 peer wip 소멸(presence 사라짐)');
    const onMain = sh('git', ['-C', aLocal, 'show', 'origin/main:note.md']);
    assert(onMain.includes('영희가 쓰는 중'), 'origin main 에 영희 내용 반영');
    const an = sh('git', ['-C', aLocal, 'log', '-1', '--format=%an', 'origin/main']).trim();
    assert(an === '영희', `main 커밋 author=영희(displayName) (got ${an})`);

    console.log('peerWipPresence: 전부 통과');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
