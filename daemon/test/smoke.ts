/**
 * Daemon 스모크: 임시 bare repo + vault 로 실제 git 시퀀스를 검증한다.
 * (실 hermes/Obsidian 없이 commit·push·idle-save·union 병합 로직만 확인.)
 * 실행: npm run smoke -w daemon
 */
import { Committer } from '../src/committer';
import type { DaemonConfig } from '../src/config';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const INIT_BARE = resolve(__dirname, '../../server-setup/init-bare-repo.sh');

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}
function git(bare: string, args: string[]): string {
  return sh('git', ['-C', bare, ...args]);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ogs-smoke-'));
  const bare = join(root, 'vault.git');
  const vault = join(root, 'vault');
  mkdirSync(vault);
  try {
    sh('bash', [INIT_BARE, bare]);

    const cfg: DaemonConfig = {
      vaultPath: vault,
      remote: bare,
      deviceId: 'smokedev',
      debounceMs: 10,
      autosaveIdleMs: 10_000_000, // 테스트 중 idle 자동저장 억제
    };
    const c = new Committer(cfg);
    await c.start();

    // 1) 파일 생성 → commitAndPush → wip 푸시
    writeFileSync(join(vault, 'note.md'), 'hello from smoke\n');
    await c.commitAndPush();
    assert(
      git(bare, ['ls-remote', '--heads', '.', 'wip/smokedev']).includes('refs/heads/wip/smokedev'),
      'wip/smokedev 원격 생성됨',
    );

    // 2) save → main 전진, note.md 도달
    assert((await c.save()) === 'saved', '첫 save = saved');
    assert(git(bare, ['show', 'main:note.md']).includes('hello from smoke'), 'note.md 가 main 에 도달');

    // 3) 변경 없는 save → nochange (빈 저장 방지)
    assert((await c.save()) === 'nochange', '변경없는 save = nochange');

    // 4) union: 외부가 main 에 앞줄 추가 + 로컬 wip 이 뒷줄 추가 → save → 양쪽 병합
    const ext = join(root, 'ext');
    sh('git', ['clone', '-q', bare, ext]);
    sh('git', ['-C', ext, 'config', 'user.email', 't@t']);
    sh('git', ['-C', ext, 'config', 'user.name', 't']);
    writeFileSync(join(ext, 'note.md'), 'FROM-MAIN\nhello from smoke\n');
    sh('git', ['-C', ext, 'commit', '-qam', 'ext-edit']);
    sh('git', ['-C', ext, 'push', '-q', 'origin', 'main']);

    writeFileSync(join(vault, 'note.md'), 'hello from smoke\nFROM-WIP\n');
    await c.commitAndPush();
    assert((await c.save()) === 'saved', 'union save = saved');
    const merged = git(bare, ['show', 'main:note.md']);
    assert(
      merged.includes('FROM-MAIN') && merged.includes('FROM-WIP'),
      `union 양쪽 병합됨 (${JSON.stringify(merged)})`,
    );

    // 5) main 커밋 수: 초기 + save1 + ext 직접푸시 + union save = 4
    const count = git(bare, ['rev-list', '--count', 'main']).trim();
    assert(count === '4', `main 커밋 4개 (got ${count})`);

    c.stop();

    // ── 시나리오 B: 기존 vault 온보딩 (populated vault + populated remote, 한글 파일명) ──
    const bareB = join(root, 'vaultB.git');
    sh('bash', [INIT_BARE, bareB]);
    const seed = join(root, 'seedB');
    sh('git', ['clone', '-q', bareB, seed]);
    sh('git', ['-C', seed, 'config', 'user.email', 't@t']);
    sh('git', ['-C', seed, 'config', 'user.name', 't']);
    writeFileSync(join(seed, 'shared.md'), 'REMOTE-VERSION\n');
    writeFileSync(join(seed, 'remote-only.md'), 'only on remote\n');
    sh('git', ['-C', seed, 'add', '-A']);
    sh('git', ['-C', seed, 'commit', '-qm', 'seed']);
    sh('git', ['-C', seed, 'push', '-q', 'origin', 'main']);

    const vaultB = join(root, 'vaultB');
    mkdirSync(vaultB);
    writeFileSync(join(vaultB, 'shared.md'), 'LOCAL-VERSION\n'); // origin/main 과 충돌
    writeFileSync(join(vaultB, 'local-only.md'), 'only on local\n');
    writeFileSync(join(vaultB, '한글노트.md'), '한글 내용\n'); // 비-ASCII (quotePath 회귀 방지)

    const b = new Committer({
      vaultPath: vaultB,
      remote: bareB,
      deviceId: 'devB',
      debounceMs: 10,
      autosaveIdleMs: 10_000_000,
    });
    await b.start(); // 크래시 없어야 함 (기존 populated-vault + populated-remote 온보딩)
    assert(existsSync(join(vaultB, 'remote-only.md')), '원격 전용 파일이 워킹트리로 실체화됨');
    assert(existsSync(join(vaultB, 'local-only.md')), '로컬 전용 파일 보존됨');
    assert(existsSync(join(vaultB, '한글노트.md')), '한글 파일 보존됨(quotePath/크래시 회귀 방지)');
    assert((await b.save()) === 'saved', '온보딩 후 save = saved');
    const treeB = git(bareB, ['ls-tree', '--name-only', 'main']);
    assert(
      ['shared.md', 'local-only.md', 'remote-only.md', '한글노트.md'].every((f) => treeB.includes(f)),
      `main 에 로컬+원격 파일 모두 존재 (${JSON.stringify(treeB)})`,
    );
    b.stop();

    // ── 시나리오 C: deviceId 영속화 (env 미지정 시 재시작 간 동일) ──
    const vaultC = join(root, 'vaultC');
    mkdirSync(vaultC);
    const baseC = { vaultPath: vaultC, remote: bareB, debounceMs: 10, autosaveIdleMs: 10_000_000 };
    const c1 = new Committer({ ...baseC });
    await c1.start();
    const id1 = c1.device;
    c1.stop();
    const c2 = new Committer({ ...baseC });
    await c2.start();
    const id2 = c2.device;
    c2.stop();
    assert(id1.length > 0 && id1 === id2, `deviceId 재시작 간 영속됨 (${id1})`);
    assert(existsSync(join(vaultC, '.git', 'ogs-device-id')), 'device-id 파일이 .git 에 저장됨');

    console.log('SMOKE OK');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
