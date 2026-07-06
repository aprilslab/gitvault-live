/**
 * GitManager 통합 테스트: 임시 bare repo 로 실제 git 시퀀스를 검증한다 (Obsidian 비의존).
 * - adopt 경로 union 시드 → 동시 같은-라인 편집 공존 (이전: 원격 승으로 로컬 소실 — 회귀 고정)
 * - sync-down TOCTOU: isStillIdle=false 면 merge 연기 (워킹트리 불변)
 * - 기존 원격 .gitattributes 내용 존중 (변조 없음)
 * 실행: npm run test:git -w plugin
 */
import { GitManager } from '../src/git/GitManager';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function initBare(root: string, name: string): string {
  const bare = join(root, name);
  sh('git', ['init', '--bare', '-b', 'main', bare]);
  return bare;
}

let cloneN = 0;
/** 외부 참여자 모사: clone → files 기록 → main 에 commit/push. */
function pushToMain(root: string, bare: string, files: Record<string, string>): void {
  const dir = join(root, `ext-${cloneN++}`);
  sh('git', ['clone', '-q', bare, dir]);
  sh('git', ['-C', dir, 'config', 'user.email', 't@t']);
  sh('git', ['-C', dir, 'config', 'user.name', 't']);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  sh('git', ['-C', dir, 'add', '-A']);
  sh('git', ['-C', dir, 'commit', '-qm', 'ext']);
  sh('git', ['-C', dir, 'push', '-q', 'origin', 'main']);
}

function newManager(basePath: string, remote: string, deviceId: string): GitManager {
  return new GitManager({ basePath, authedRemote: remote, deviceId, flushEditors: async () => undefined });
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ogs-gm-'));
  try {
    // ── 1) adopt 경로에서도 union 시드 + 동시 같은-라인 편집 공존 ──
    const bare1 = initBare(root, 'r1.git');
    pushToMain(root, bare1, { 'note.md': 'line1\nline2\nline3\n' }); // .gitattributes 없는 기존 원격
    const vault1 = join(root, 'v1');
    mkdirSync(vault1);
    const g1 = newManager(vault1, bare1, 'dev1');
    await g1.ensureRepo();
    assert(
      readFileSync(join(vault1, '.gitattributes'), 'utf8').includes('merge=union'),
      'adopt 경로에서 .gitattributes union 시드됨',
    );

    // 외부와 로컬이 같은 라인(line2)을 다르게 편집 — 진짜 충돌 케이스
    pushToMain(root, bare1, { 'note.md': 'line1\nline2-REMOTE\nline3\n' });
    writeFileSync(join(vault1, 'note.md'), 'line1\nline2-LOCAL\nline3\n');
    await g1.commitAndPushWip();
    await g1.syncDown(true);
    const merged = readFileSync(join(vault1, 'note.md'), 'utf8');
    assert(
      merged.includes('line2-REMOTE') && merged.includes('line2-LOCAL'),
      `동시 같은-라인 편집 양쪽 공존 (${JSON.stringify(merged)})`,
    );

    // ── 2) TOCTOU: merge 직전 재판정 — 타이핑 중이면 워킹트리 불변 ──
    pushToMain(root, bare1, { 'incoming.md': 'from remote\n' });
    await g1.syncDown(true, () => false); // fetch 는 하되 merge 는 연기
    assert(!existsSync(join(vault1, 'incoming.md')), '타이핑 감지 → merge 연기(워킹트리 불변)');
    await g1.syncDown(true, () => true);
    assert(existsSync(join(vault1, 'incoming.md')), 'idle → 다음 사이클에 병합됨');

    // ── 3) 기존 원격 .gitattributes 는 내용 그대로 존중 ──
    const CUSTOM = '# custom rules\n*.bin binary\n';
    const bare2 = initBare(root, 'r2.git');
    pushToMain(root, bare2, { '.gitattributes': CUSTOM, 'a.md': 'x\n' });
    const vault2 = join(root, 'v2');
    mkdirSync(vault2);
    const g2 = newManager(vault2, bare2, 'dev2');
    await g2.ensureRepo(); // union 부재 경고 로그만 — 변조 없음
    assert(readFileSync(join(vault2, '.gitattributes'), 'utf8') === CUSTOM, '기존 .gitattributes 미변조');

    // ── 4) mainFileContent (인라인 데코 diff 기준) ──
    const content = await g1.mainFileContent('note.md');
    assert(content !== null && content.includes('line2-REMOTE'), 'mainFileContent = origin/main 내용');
    assert((await g1.mainFileContent('없는파일.md')) === null, 'origin/main 에 없는 파일 = null');

    // --- mainBlameLines: origin/main 각 줄 작성자+epoch 파싱 ---
    {
      const root = mkdtempSync(join(tmpdir(), 'ogs-blame-'));
      const bare = initBare(root, 'blame.git');
      pushToMain(root, bare, { 'note.md': '첫째 줄\n둘째 줄\n셋째 줄\n' });
      const local = join(root, 'local');
      mkdirSync(local, { recursive: true });
      const gm = newManager(local, bare, 'dev-A');
      await gm.ensureRepo();

      const blame = await gm.mainBlameLines('note.md');
      assert(blame.length === 3, `blame 3줄 (got ${blame.length})`);
      assert(blame.every((b) => b.author === 't'), 'blame 작성자=t(pushToMain 커밋자)');
      assert(blame.every((b) => b.epoch > 0), 'blame epoch>0');

      const none = await gm.mainBlameLines('does-not-exist.md');
      assert(none.length === 0, '없는 파일 → 빈 배열');

      rmSync(root, { recursive: true, force: true });
    }

    // --- identity: displayName 이 커밋 author.name 이 된다 ---
    {
      const root = mkdtempSync(join(tmpdir(), 'ogs-ident-'));
      const bare = initBare(root, 'id.git');
      const local = join(root, 'local');
      mkdirSync(local, { recursive: true });
      const gm = new GitManager({
        basePath: local,
        authedRemote: bare,
        deviceId: 'dev-xyz',
        displayName: '홍길동',
        flushEditors: async () => undefined,
      });
      await gm.ensureRepo();
      writeFileSync(join(local, 'a.md'), '내용\n');
      await gm.commitAndPushWip();
      const an = execFileSync('git', ['-C', local, 'log', '-1', '--format=%an'], { encoding: 'utf8' }).trim();
      assert(an === '홍길동', `author.name=displayName (got ${an})`);
      rmSync(root, { recursive: true, force: true });
    }

    console.log('GITMANAGER OK');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
