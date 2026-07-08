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
    // NOTE: Windows autocrlf=true 로컬 환경에서는 checkout 시 LF→CRLF 변환됨 — pre-existing 실패.
    // 바이트 일치 대신 논리적 일치 검증(줄바꿈 정규화). CI(Linux) 는 원본 그대로 통과.
    const actualAttrs = readFileSync(join(vault2, '.gitattributes'), 'utf8').replace(/\r\n/g, '\n');
    assert(actualAttrs === CUSTOM, `기존 .gitattributes 미변조 (got ${JSON.stringify(actualAttrs)})`);

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
      // 원격 main 부트스트랩(외부 커밋). config(seed) 가 이미 발행된 성숙한 공유 vault 를 모사한다 —
      // 그래야 최초 로드가 idle(디스크==origin/main)로 남는다. seed 내용은 seedRepoFiles() 와 정확히 일치.
      pushToMain(root, bare, {
        'seed.md': 'seed\n',
        '.gitattributes': '*.md merge=union\n* text=auto eol=lf\n',
        '.gitignore': '.obsidian/\n.DS_Store\nThumbs.db\n',
      });
      const local = join(root, 'local');
      mkdirSync(local, { recursive: true });
      const gm = newManager(local, bare, 'dev-A');
      await gm.ensureRepo();

      // 로드 직후: eager fork → HEAD=wip/<device>/<ts> (편집 없어도 세션 wip 고정)
      const head0 = execFileSync('git', ['-C', local, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      assert(/^wip\/dev-A\/\d+$/.test(head0), `eager fork 후 HEAD=wip (got ${head0})`);

      // 편집 → commitAndPushWip: 이미 세션 wip 위 → 커밋 + push (재-fork 없음)
      writeFileSync(join(local, 'note.md'), '첫 줄\n');
      await gm.commitAndPushWip();
      const headWip = execFileSync('git', ['-C', local, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      assert(headWip === head0, `편집 후에도 같은 세션 wip 유지 (got ${headWip}, expected ${head0})`);
      const remoteWips = execFileSync('git', ['-C', local, 'ls-remote', '--heads', 'origin', 'wip/dev-A/*'], { encoding: 'utf8' }).trim();
      assert(remoteWips.includes(headWip), '원격에 wip 푸시됨');

      // 저장 → origin main 1커밋(squash) + 이전 세션 wip 삭제(로컬+원격) → 즉시 새 세션 wip fork (eager)
      const save = await gm.squashMergeToMain();
      assert(save === 'saved', `저장 saved (got ${save})`);
      const headAfter = execFileSync('git', ['-C', local, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      assert(/^wip\/dev-A\/\d+$/.test(headAfter), `저장 후 HEAD=새 세션 wip (eager) (got ${headAfter})`);
      assert(headAfter !== headWip, `새 세션 wip 은 이전과 다른 ts (both got ${headWip})`);
      const localWips = execFileSync('git', ['-C', local, 'branch', '--list', 'wip/*'], { encoding: 'utf8' }).trim();
      assert(!localWips.includes(headWip), `이전 로컬 wip(${headWip}) 삭제됨 (got '${localWips}')`);
      const remoteWips2 = execFileSync('git', ['-C', local, 'ls-remote', '--heads', 'origin', 'wip/dev-A/*'], { encoding: 'utf8' }).trim();
      assert(remoteWips2 === '', '원격 wip 삭제됨 (새 세션 wip 은 아직 push 전)');
      // origin main 에 note.md 반영 + 커밋 1개 추가(squash)
      const noteOnMain = execFileSync('git', ['-C', local, 'show', 'origin/main:note.md'], { encoding: 'utf8' });
      assert(noteOnMain.includes('첫 줄'), 'origin main 에 저장 내용 반영');

      // 마이그레이션: 기존 영속 wip/<device> 가 있으면 로드 시 삭제.
      // 준비: eager fork 로 남은 wip/dev-A/<ts>(=headAfter) 를 지워 D/F 없이 레거시 wip/dev-A 를 만들 수 있게 한다.
      execFileSync('git', ['-C', local, 'checkout', 'main']);
      execFileSync('git', ['-C', local, 'branch', '-D', headAfter]);
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

      // 자기 wip 는 제외 — dev-A 가 편집 후 push. 같은 gm 인스턴스로 검증한다(ensureRepo 재호출 금지):
      // ensureRepo → deleteOwnWips 가 자기 wip 를 원격/로컬에서 지워버려, 지운 뒤 필터를 걸면
      // 애초에 걸러낼 대상이 없어 검증이 무의미해진다(회귀를 못 잡음).
      writeFileSync(join(local, 'note.md'), '공용\n내 편집\n');
      await gm.commitAndPushWip();
      const ownWipRemote = execFileSync(
        'git',
        ['-C', local, 'ls-remote', '--heads', 'origin', 'wip/dev-A/*'],
        { encoding: 'utf8' },
      ).trim();
      assert(ownWipRemote !== '', '자기 wip 가 원격에 살아있음(제외 필터 검증 전제)');

      const peers2 = await gm.listPeerWips();
      assert(peers2.every((p) => p.device !== 'dev-A'), '자기 wip 제외');
      assert(peers2.some((p) => p.device === 'dev-B'), 'dev-B peer 는 여전히 보임(빈 배열이라 통과한 게 아님)');

      rmSync(root, { recursive: true, force: true });
    }

    // --- [CRITICAL] clean-behind 재연결: 앱이 닫힌 사이 팀원이 저장해 origin/main 만 앞선 뒤 ---
    // 재연결해도 팀원 저장분이 되돌려지지 않고, 로컬 미저장 편집으로 오탐되어 adopt 되지 않는다.
    // 이 케이스는 ensureOnMain 이 (버그처럼) origin/main 으로 먼저 advance 후 status 를 보면 실패한다.
    {
      const root = mkdtempSync(join(tmpdir(), 'ogs-cb-'));
      const bare = initBare(root, 'cb.git');
      pushToMain(root, bare, { 'note.md': 'v0\n' }); // origin/main 부트스트랩
      const vaultA = join(root, 'vaultA');
      mkdirSync(vaultA, { recursive: true });

      // dev-A: 최초 로드 → 편집 → 저장 (로컬 main == origin/main == v1, union 드라이버 발행)
      const gA = newManager(vaultA, bare, 'dev-A');
      await gA.ensureRepo();
      writeFileSync(join(vaultA, 'note.md'), 'v1\n');
      await gA.commitAndPushWip();
      const saved = await gA.squashMergeToMain();
      assert(saved === 'saved', `dev-A v1 저장 (got ${saved})`);
      assert(
        execFileSync('git', ['-C', bare, 'show', 'main:note.md'], { encoding: 'utf8' }).trim() === 'v1',
        'origin/main == v1(dev-A 저장분)',
      );

      // 팀원(외부 clone)이 v2 를 origin/main 에 push — 그 사이 dev-A 앱은 닫혀 있었다
      pushToMain(root, bare, { 'note.md': 'v2\n' });

      // dev-A 재연결: 새 GitManager, 같은 디렉토리, 로컬 편집 없음(clean, 단지 뒤처짐)
      const gA2 = newManager(vaultA, bare, 'dev-A');
      await gA2.ensureRepo();

      // (a) 디스크 파일 == v2 (팀원 저장분 실체화)
      assert(
        readFileSync(join(vaultA, 'note.md'), 'utf8').trim() === 'v2',
        '재연결 후 디스크==v2(팀원 저장분 실체화)',
      );
      // (b) HEAD == eager 세션 wip (편집 없어도 세션 wip 고정)
      const head = execFileSync('git', ['-C', vaultA, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      assert(/^wip\/dev-A\/\d+$/.test(head), `재연결 후 HEAD=eager 세션 wip (got ${head})`);
      // (c) clean 이므로 adopt 커밋 없이 fresh fork (base 위 0 커밋)
      const wipsLines = execFileSync('git', ['-C', vaultA, 'branch', '--list', 'wip/*'], { encoding: 'utf8' })
        .split('\n').filter((l) => l.trim().length > 0);
      assert(wipsLines.length === 1, `재연결 시 새 세션 wip 하나만 (got ${JSON.stringify(wipsLines)})`);
      const wipAhead = execFileSync('git', ['-C', vaultA, 'rev-list', '--count', 'main..HEAD'], { encoding: 'utf8' }).trim();
      assert(wipAhead === '0', `clean → wip 은 main 위로 커밋 없이 fork (adopt 오탐 없음) (got ${wipAhead})`);
      // (d) origin(bare)/main 여전히 == v2 (되돌려지지 않음)
      assert(
        execFileSync('git', ['-C', bare, 'show', 'main:note.md'], { encoding: 'utf8' }).trim() === 'v2',
        'origin/main 여전히 v2(되돌려지지 않음)',
      );

      rmSync(root, { recursive: true, force: true });
    }

    // --- 오프라인 편집 + 팀원 진행: 재연결 adopt → 저장 시 양쪽 변경 공존(union, 유실 없음) ---
    {
      const root = mkdtempSync(join(tmpdir(), 'ogs-oe-'));
      const bare = initBare(root, 'oe.git');
      pushToMain(root, bare, { 'seed.md': 'x\n' }); // origin 부트스트랩(note 없음)
      const vault = join(root, 'vault');
      mkdirSync(vault, { recursive: true });

      // dev-A: baseline v1 저장 (note = L1/L2/L3), union 드라이버 발행
      const g = newManager(vault, bare, 'dev-A');
      await g.ensureRepo();
      writeFileSync(join(vault, 'note.md'), 'L1\nL2\nL3\n');
      await g.commitAndPushWip();
      await g.squashMergeToMain();

      // 오프라인 편집: L1 변경, 저장하지 않음(디스크만) — 이후 팀원이 다른 줄(L3) 변경분 v2 push
      writeFileSync(join(vault, 'note.md'), 'L1-A\nL2\nL3\n');
      pushToMain(root, bare, { 'note.md': 'L1\nL2\nL3-PEER\n' });

      // dev-A 재연결 → dirty(디스크 vs base v1) → adopt
      const g2 = newManager(vault, bare, 'dev-A');
      await g2.ensureRepo();
      const head = execFileSync('git', ['-C', vault, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      assert(/^wip\/dev-A\/\d+$/.test(head), `오프라인 편집 → adopt(HEAD=wip) (got ${head})`);

      // 저장 → union: 내 L1 편집과 팀원 L3 편집이 모두 origin/main 에 반영(둘 다 유실 없음)
      const saved = await g2.squashMergeToMain();
      assert(saved === 'saved', `union 저장 saved (got ${saved})`);
      const merged = execFileSync('git', ['-C', bare, 'show', 'main:note.md'], { encoding: 'utf8' });
      assert(merged.includes('L1-A'), `origin/main 에 내 오프라인 편집 보존 (${JSON.stringify(merged)})`);
      assert(merged.includes('L3-PEER'), `origin/main 에 팀원 편집 보존 (${JSON.stringify(merged)})`);

      rmSync(root, { recursive: true, force: true });
    }

    // --- .obsidian/ 은 추적되지 않는다: seed .gitignore 가 add 이전에 배치되므로 adopt 커밋에 새지 않음 ---
    {
      const root = mkdtempSync(join(tmpdir(), 'ogs-obs-'));
      const bare = initBare(root, 'obs.git');
      pushToMain(root, bare, { 'note.md': 'base\n' }); // 기존 원격(.gitignore 미보유) — 첫 init 케이스
      const vault = join(root, 'vault');
      mkdirSync(join(vault, '.obsidian'), { recursive: true });
      writeFileSync(join(vault, '.obsidian', 'workspace.json'), '{"x":1}\n'); // vault 로컬 obsidian 상태

      const g = newManager(vault, bare, 'dev-A');
      await g.ensureRepo();
      writeFileSync(join(vault, 'note.md'), 'edited\n');
      await g.commitAndPushWip();
      await g.squashMergeToMain();

      const tracked = execFileSync('git', ['-C', vault, 'ls-files'], { encoding: 'utf8' });
      assert(!/\.obsidian\//.test(tracked), `.obsidian/ 미추적(로컬 ls-files) (${JSON.stringify(tracked)})`);
      const onMain = execFileSync('git', ['-C', vault, 'ls-tree', '-r', '--name-only', 'origin/main'], { encoding: 'utf8' });
      assert(!/\.obsidian\//.test(onMain), `.obsidian/ 미추적(origin/main) (${JSON.stringify(onMain)})`);

      rmSync(root, { recursive: true, force: true });
    }

    // --- [CRITICAL] D/F ref 충돌 회귀: 레거시 wip/<device>(구버전 영속 브랜치) + dirty 워킹트리 동시 존재 ---
    // 구버전(영속 wip) 빌드가 남긴 wip/dev-A 가 아직 정리 안 된 상태로, 오프라인 편집 중(dirty) 앱을
    // 새 빌드로 재시작하면 ensureOnMain 의 adopt 포크(`checkout -b wip/dev-A/<ts>`)가
    // 'refs/heads/wip/dev-A' 존재로 인한 D/F(디렉토리/파일) 충돌로 fatal 나던 회귀.
    // deleteOwnWips() 를 adopt 포크 '전'(HEAD 가 main 에 오른 직후)으로 옮겨 고정 — 기존 레거시+CLEAN
    // 마이그레이션 테스트(위 ephemeral wip 생명주기 블록)는 dirty 조합을 다루지 않아 이 회귀를 못 잡았었다.
    {
      const root = mkdtempSync(join(tmpdir(), 'ogs-df-'));
      const bare = initBare(root, 'df.git');
      pushToMain(root, bare, { 'note.md': 'base\n' }); // origin/main 부트스트랩
      const vault = join(root, 'vault');
      mkdirSync(vault, { recursive: true });

      // dev-A: 최초 로드 → 편집 → 저장 (origin/main 확립 + 로컬 main 존재)
      const gA = newManager(vault, bare, 'dev-A');
      await gA.ensureRepo();
      writeFileSync(join(vault, 'note.md'), 'v1\n');
      await gA.commitAndPushWip();
      const saved = await gA.squashMergeToMain();
      assert(saved === 'saved', `dev-A v1 저장 (got ${saved})`);

      // 구버전 빌드가 남긴 레거시 영속 wip/dev-A 모사(ts 없음) — 로컬 + 원격.
      // 준비: eager fork 로 남은 세션 wip/dev-A/<ts> 를 먼저 지워 D/F 없이 레거시 이름을 만들 수 있게 한다.
      execFileSync('git', ['-C', vault, 'checkout', 'main']);
      const eagerWips = execFileSync('git', ['-C', vault, 'branch', '--list', 'wip/dev-A/*'], { encoding: 'utf8' })
        .split('\n').map((l) => l.replace(/^\*?\s*/, '').trim()).filter(Boolean);
      for (const w of eagerWips) execFileSync('git', ['-C', vault, 'branch', '-D', w]);
      execFileSync('git', ['-C', vault, 'branch', 'wip/dev-A', 'main']);
      execFileSync('git', ['-C', vault, 'push', '-q', 'origin', 'wip/dev-A']);

      // 마이그레이션 완료 전 dirty 워킹트리(오프라인 편집) — 이 조합이 D/F 충돌을 유발했다.
      writeFileSync(join(vault, 'note.md'), 'v1-dirty\n');

      // 프레시 GitManager(새 인스턴스, 같은 vault 디렉토리) — 로드 시 ensureOnMain 이 adopt 포크를 시도.
      const gA2 = newManager(vault, bare, 'dev-A');
      let threw: unknown = null;
      try {
        await gA2.ensureRepo();
      } catch (e) {
        threw = e;
      }
      assert(threw === null, `(a) 레거시+dirty 동시 존재해도 ensureRepo 안 던짐 (got ${threw instanceof Error ? threw.message : threw})`);

      const legacyLocal = execFileSync('git', ['-C', vault, 'branch', '--list', 'wip/dev-A'], { encoding: 'utf8' }).trim();
      assert(legacyLocal === '', `(b) 레거시 로컬 wip/dev-A 삭제됨 (got '${legacyLocal}')`);
      const legacyRemote = execFileSync('git', ['-C', vault, 'ls-remote', '--heads', 'origin', 'wip/dev-A'], { encoding: 'utf8' }).trim();
      assert(legacyRemote === '', `(b) 레거시 원격 wip/dev-A 삭제됨 (got '${legacyRemote}')`);

      const head = execFileSync('git', ['-C', vault, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      assert(/^wip\/dev-A\/\d+$/.test(head) || head === 'main', `(c) HEAD=adopt wip 또는 main, D/F 아님 (got ${head})`);
      assert(
        readFileSync(join(vault, 'note.md'), 'utf8') === 'v1-dirty\n',
        '(d) dirty 편집 내용 보존(워킹트리 불변, D/F 에러로 중단되지 않았음)',
      );

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
