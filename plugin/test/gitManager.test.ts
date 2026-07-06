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

    // --- ephemeral wip 생명주기 ---
    {
      const root = mkdtempSync(join(tmpdir(), 'ogs-life-'));
      const bare = initBare(root, 'life.git');
      // 원격 main 부트스트랩(외부 커밋)
      pushToMain(root, bare, { 'seed.md': 'seed\n' });
      const local = join(root, 'local');
      mkdirSync(local, { recursive: true });
      const gm = newManager(local, bare, 'dev-A');
      await gm.ensureRepo();

      // 로드 직후 idle: HEAD=main, wip 없음
      const head0 = execFileSync('git', ['-C', local, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      assert(head0 === 'main', `idle HEAD=main (got ${head0})`);

      // 편집 → commitAndPushWip: wip/<device>/<ts> fork + push
      writeFileSync(join(local, 'note.md'), '첫 줄\n');
      await gm.commitAndPushWip();
      const headWip = execFileSync('git', ['-C', local, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      assert(/^wip\/dev-A\/\d+$/.test(headWip), `편집 시 HEAD=wip/dev-A/<ts> (got ${headWip})`);
      const remoteWips = execFileSync('git', ['-C', local, 'ls-remote', '--heads', 'origin', 'wip/dev-A/*'], { encoding: 'utf8' }).trim();
      assert(remoteWips.includes(headWip), '원격에 wip 푸시됨');

      // 저장 → origin main 1커밋(squash) + wip 삭제(로컬+원격) + HEAD=main
      const save = await gm.squashMergeToMain();
      assert(save === 'saved', `저장 saved (got ${save})`);
      const headAfter = execFileSync('git', ['-C', local, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      assert(headAfter === 'main', `저장 후 HEAD=main (got ${headAfter})`);
      const localWips = execFileSync('git', ['-C', local, 'branch', '--list', 'wip/*'], { encoding: 'utf8' }).trim();
      assert(localWips === '', `로컬 wip 삭제됨 (got '${localWips}')`);
      const remoteWips2 = execFileSync('git', ['-C', local, 'ls-remote', '--heads', 'origin', 'wip/dev-A/*'], { encoding: 'utf8' }).trim();
      assert(remoteWips2 === '', '원격 wip 삭제됨');
      // origin main 에 note.md 반영 + 커밋 1개 추가(squash)
      const noteOnMain = execFileSync('git', ['-C', local, 'show', 'origin/main:note.md'], { encoding: 'utf8' });
      assert(noteOnMain.includes('첫 줄'), 'origin main 에 저장 내용 반영');

      // 마이그레이션: 기존 영속 wip/<device> 가 있으면 로드 시 삭제
      execFileSync('git', ['-C', local, 'branch', 'wip/dev-A', 'main']); // 레거시 영속 브랜치 모사
      execFileSync('git', ['-C', local, 'push', '-q', 'origin', 'wip/dev-A']);
      const gm2 = newManager(local, bare, 'dev-A');
      await gm2.ensureRepo();
      const legacyLocal = execFileSync('git', ['-C', local, 'branch', '--list', 'wip/dev-A'], { encoding: 'utf8' }).trim();
      assert(legacyLocal === '', '레거시 로컬 wip/dev-A 삭제됨');
      const legacyRemote = execFileSync('git', ['-C', local, 'ls-remote', '--heads', 'origin', 'wip/dev-A'], { encoding: 'utf8' }).trim();
      assert(legacyRemote === '', '레거시 원격 wip/dev-A 삭제됨');

      rmSync(root, { recursive: true, force: true });
    }

    // --- peer wip 읽기 ---
    {
      const root = mkdtempSync(join(tmpdir(), 'ogs-peer-'));
      const bare = initBare(root, 'peer.git');
      pushToMain(root, bare, { 'note.md': '공용\n' });

      // 참여자 B가 wip/dev-B/<ts> 를 원격에 푸시(외부 clone 으로 모사)
      const bdir = join(root, 'devB');
      execFileSync('git', ['clone', '-q', bare, bdir]);
      execFileSync('git', ['-C', bdir, 'config', 'user.name', '영희']);
      execFileSync('git', ['-C', bdir, 'config', 'user.email', 'dev-B@t']);
      execFileSync('git', ['-C', bdir, 'checkout', '-b', 'wip/dev-B/123']);
      writeFileSync(join(bdir, 'note.md'), '공용\n영희 작업중\n');
      execFileSync('git', ['-C', bdir, 'add', '-A']);
      execFileSync('git', ['-C', bdir, 'commit', '-qm', 'wip']);
      execFileSync('git', ['-C', bdir, 'push', '-q', 'origin', 'wip/dev-B/123']);

      const local = join(root, 'localA');
      mkdirSync(local, { recursive: true });
      const gm = newManager(local, bare, 'dev-A');
      await gm.ensureRepo(); // fetch --prune 로 origin/wip/dev-B/123 확보

      const peers = await gm.listPeerWips();
      assert(peers.length === 1, `peer 1명 (got ${peers.length})`);
      assert(peers[0].device === 'dev-B', `device=dev-B (got ${peers[0].device})`);
      assert(peers[0].author === '영희', `author=영희 (got ${peers[0].author})`);

      const content = await gm.peerWipContent(peers[0].ref, 'note.md');
      assert(content !== null && content.includes('영희 작업중'), 'peer wip 파일 내용 읽음');

      // 자기 wip 는 제외 — dev-A 가 편집 후 push
      writeFileSync(join(local, 'note.md'), '공용\n내 편집\n');
      await gm.commitAndPushWip();
      const gm2 = newManager(local, bare, 'dev-A');
      await gm2.ensureRepo();
      const peers2 = await gm2.listPeerWips();
      assert(peers2.every((p) => p.device !== 'dev-A'), '자기 wip 제외');

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
