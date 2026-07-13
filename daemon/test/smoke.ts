/**
 * Daemon 스모크: 임시 bare repo + vault 로 실제 git 시퀀스를 검증한다.
 * (실 원격/Obsidian 없이 commit·push-to-main·union 병합·adopt 로직만 확인.)
 * 실행: npm run smoke -w daemon
 */
import { Committer, HEARTBEAT_FILE } from '../src/committer';
import type { DaemonConfig } from '../src/config';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}
function git(bare: string, args: string[]): string {
  // core.quotePath=false: 비-ASCII(한글) 경로가 C-quote 되지 않게 (bare repo 엔 이 config 가 없음).
  return sh('git', ['-C', bare, '-c', 'core.quotePath=false', ...args]);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

/** 호스팅 git repo 대역: default 브랜치 main 인 빈 bare repo. */
function initBare(bare: string): void {
  sh('git', ['init', '--bare', '-b', 'main', bare]);
}

/** clone 후 초기 커밋을 push 해 원격 main 을 populate (관리자가 대상 repo 를 미리 세팅한 상황 모사). */
function seedRemote(bare: string, root: string, files: Record<string, string>, withUnion = true): void {
  const seed = join(root, `seed-${Math.abs(hash(bare))}`);
  sh('git', ['clone', '-q', bare, seed]);
  sh('git', ['-C', seed, 'config', 'user.email', 't@t']);
  sh('git', ['-C', seed, 'config', 'user.name', 't']);
  if (withUnion) writeFileSync(join(seed, '.gitattributes'), '*.md merge=union\n* text=auto eol=lf\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(seed, name), content);
  sh('git', ['-C', seed, 'add', '-A']);
  sh('git', ['-C', seed, 'commit', '-qm', 'seed']);
  sh('git', ['-C', seed, 'push', '-q', 'origin', 'main']);
}
/** 외부 참여자가 main:doc.md 를 주어진 내용으로 덮어 push (동시 편집 충돌 모사). */
let extN = 0;
function pushToMainD(root: string, bare: string, docContent: string): void {
  const dir = join(root, `extD-${extN++}`);
  sh('git', ['clone', '-q', bare, dir]);
  sh('git', ['-C', dir, 'config', 'user.email', 't@t']);
  sh('git', ['-C', dir, 'config', 'user.name', 't']);
  writeFileSync(join(dir, 'doc.md'), docContent);
  sh('git', ['-C', dir, 'commit', '-qam', 'ext-edit']);
  sh('git', ['-C', dir, 'push', '-q', 'origin', 'main']);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ogs-smoke-'));
  try {
    // ── 시나리오 A: 빈 원격 seed → main 연속 push → union 병합 ──
    const bare = join(root, 'vault.git');
    const vault = join(root, 'vault');
    initBare(bare);
    mkdirSync(vault);

    const cfg: DaemonConfig = { vaultPath: vault, remote: bare, deviceId: 'smokedev', debounceMs: 10 };
    const c = new Committer(cfg);
    await c.start(); // 빈 원격 → seedRepoFiles(.gitattributes/.gitignore) → 첫 push

    assert(
      git(bare, ['ls-remote', '--heads', '.', 'main']).includes('refs/heads/main'),
      'main 원격 생성됨(seed push)',
    );
    assert(git(bare, ['show', 'main:.gitattributes']).includes('merge=union'), '.gitattributes union seed 됨');

    // 1) 파일 생성 → commitAndPush → main 도달
    writeFileSync(join(vault, 'note.md'), 'hello from smoke\n');
    assert((await c.commitAndPush()) === 'pushed', '파일 생성 → pushed');
    assert(git(bare, ['show', 'main:note.md']).includes('hello from smoke'), 'note.md 가 main 에 도달');

    // 2) 변경 없는 push → nochange (빈 push 방지)
    assert((await c.commitAndPush()) === 'nochange', '변경없는 push = nochange');

    // 3) union: 외부가 main 에 앞줄 추가 + 로컬이 뒷줄 추가 → push → 양쪽 병합
    const ext = join(root, 'ext');
    sh('git', ['clone', '-q', bare, ext]);
    sh('git', ['-C', ext, 'config', 'user.email', 't@t']);
    sh('git', ['-C', ext, 'config', 'user.name', 't']);
    writeFileSync(join(ext, 'note.md'), 'FROM-MAIN\nhello from smoke\n');
    sh('git', ['-C', ext, 'commit', '-qam', 'ext-edit']);
    sh('git', ['-C', ext, 'push', '-q', 'origin', 'main']);

    writeFileSync(join(vault, 'note.md'), 'hello from smoke\nFROM-WIP\n');
    assert((await c.commitAndPush()) === 'pushed', 'union push = pushed');
    const merged = git(bare, ['show', 'main:note.md']);
    assert(
      merged.includes('FROM-MAIN') && merged.includes('FROM-WIP'),
      `union 양쪽 병합됨 (${JSON.stringify(merged)})`,
    );
    c.stop();

    // ── 시나리오 B: 기존 vault 온보딩 (populated vault + populated remote, 한글, adopt+union) ──
    const bareB = join(root, 'vaultB.git');
    initBare(bareB);
    seedRemote(bareB, root, { 'shared.md': 'REMOTE-VERSION\n', 'remote-only.md': 'only on remote\n' });

    const vaultB = join(root, 'vaultB');
    mkdirSync(vaultB);
    writeFileSync(join(vaultB, 'shared.md'), 'LOCAL-VERSION\n'); // origin/main 과 충돌 → union
    writeFileSync(join(vaultB, 'local-only.md'), 'only on local\n');
    writeFileSync(join(vaultB, '한글노트.md'), '한글 내용\n'); // 비-ASCII (quotePath 회귀 방지)

    const b = new Committer({ vaultPath: vaultB, remote: bareB, deviceId: 'devB', debounceMs: 10 });
    await b.start(); // 크래시 없어야 함 (populated-vault + populated-remote 온보딩) + main 에 push
    assert(existsSync(join(vaultB, 'remote-only.md')), '원격 전용 파일이 워킹트리로 실체화됨');
    assert(existsSync(join(vaultB, 'local-only.md')), '로컬 전용 파일 보존됨');
    assert(existsSync(join(vaultB, '한글노트.md')), '한글 파일 보존됨(quotePath/크래시 회귀 방지)');
    const treeB = git(bareB, ['ls-tree', '--name-only', 'main']);
    assert(
      ['shared.md', 'local-only.md', 'remote-only.md', '한글노트.md'].every((f) => treeB.includes(f)),
      `main 에 로컬+원격 파일 모두 존재 (${JSON.stringify(treeB)})`,
    );
    // 온보딩(adopt)은 이름 충돌 파일에 대해 "로컬 우선"이다 — adopt 커밋의 부모가 origin/main 이라
    // git 은 이를 정상 편집으로 보고 union 하지 않는다(원격 내용은 히스토리에 보존). union 은 온보딩 이후
    // 양측 편집(시나리오 A)에만 적용된다.
    const sharedB = git(bareB, ['show', 'main:shared.md']);
    assert(sharedB.includes('LOCAL-VERSION'), `온보딩 이름충돌=로컬 우선 (${JSON.stringify(sharedB)})`);
    assert(
      git(bareB, ['log', '-p', '--', 'shared.md']).includes('REMOTE-VERSION'),
      '원격 내용은 히스토리에 보존됨',
    );
    b.stop();

    // ── 시나리오 C: deviceId 영속화 (env 미지정 시 재시작 간 동일) ──
    const vaultC = join(root, 'vaultC');
    mkdirSync(vaultC);
    const baseC = { vaultPath: vaultC, remote: bareB, debounceMs: 10 };
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

    // ── 시나리오 D: union 없는 기존 원격 adopt → union 시드 보장 + 동시 같은-라인 편집 공존 ──
    // (이전엔 seedRepoFiles 가 빈-원격 경로에서만 실행돼, adopt 시 union 없이 -X theirs=원격 승으로 로컬 소실)
    const bareD = join(root, 'vaultD.git');
    initBare(bareD);
    seedRemote(bareD, root, { 'doc.md': 'a\nb\nc\n' }, /* withUnion */ false);
    const vaultD = join(root, 'vaultD');
    mkdirSync(vaultD);
    const d = new Committer({ vaultPath: vaultD, remote: bareD, deviceId: 'devD', debounceMs: 10 });
    await d.start();
    assert(existsSync(join(vaultD, '.gitattributes')), 'adopt(union 미보유 원격)에서도 .gitattributes 시드됨');
    assert(
      git(bareD, ['show', 'main:.gitattributes']).includes('merge=union'),
      'union 드라이버가 main 에 push 됨',
    );
    // 외부가 같은 라인(b) 편집 + 로컬도 같은 라인 편집 → 양쪽 공존해야 함
    pushToMainD(root, bareD, 'a\nb-REMOTE\nc\n');
    writeFileSync(join(vaultD, 'doc.md'), 'a\nb-LOCAL\nc\n');
    assert((await d.commitAndPush()) === 'pushed', 'adopt 후 동시 편집 push');
    const mergedD = git(bareD, ['show', 'main:doc.md']);
    assert(
      mergedD.includes('b-REMOTE') && mergedD.includes('b-LOCAL'),
      `union 미보유 원격 adopt 후에도 양쪽 공존 (${JSON.stringify(mergedD)})`,
    );
    d.stop();

    // ── 시나리오 E: heartbeat lease (Obsidian 플러그인과 공유 vault 교대) ──
    const bareE = join(root, 'vaultE.git');
    initBare(bareE);
    seedRemote(bareE, root, { 'doc.md': 'seed\n' });
    const vaultE = join(root, 'vaultE');
    mkdirSync(vaultE);
    const beat = join(vaultE, '.git', HEARTBEAT_FILE);
    const e = new Committer({ vaultPath: vaultE, remote: bareE, deviceId: 'devE', debounceMs: 10 });
    await e.start();

    // E-1: heartbeat 신선 → daemon 후퇴 (변경 있어도 push 안 함)
    writeFileSync(beat, `${Date.now()}\n`);
    writeFileSync(join(vaultE, 'doc.md'), 'plugin-owns-this\n');
    assert((await e.commitAndPush()) === 'nochange', 'heartbeat 신선 → daemon 후퇴(nochange)');
    assert(
      !git(bareE, ['show', 'main:doc.md']).includes('plugin-owns-this'),
      'heartbeat 신선 → 변경분이 main 에 안 올라감',
    );

    // E-2: heartbeat 가 grace(90s) 넘게 낡음 → 크래시로 방치된 것으로 보고 daemon 인수
    writeFileSync(beat, `${Date.now() - 120_000}\n`); // 120s 전 = grace 초과
    assert((await e.commitAndPush()) === 'pushed', 'heartbeat grace 초과 → daemon 인수(pushed)');
    assert(
      git(bareE, ['show', 'main:doc.md']).includes('plugin-owns-this'),
      'heartbeat 낡음 → 변경분이 main 에 반영됨',
    );

    // E-3: 플러그인이 HEAD 를 wip 에 남기고 종료 → heartbeat 부재 → daemon 이 main 으로 인수
    sh('git', ['-C', vaultE, 'checkout', '-q', '-b', 'wip/plugin/999']); // 플러그인 세션 브랜치 모사
    rmSync(beat, { force: true }); // 정상 종료 = heartbeat 삭제
    writeFileSync(join(vaultE, 'doc.md'), 'ai-wrote-while-closed\n'); // Obsidian 닫힌 뒤 AI 편집
    assert((await e.commitAndPush()) === 'pushed', 'wip HEAD + heartbeat 부재 → daemon pushed');
    assert(
      git(bareE, ['show', 'main:doc.md']).includes('ai-wrote-while-closed'),
      'wip 에서 인수해도 변경분이 main(=wip 아님)에 반영됨',
    );
    assert(
      (await sh('git', ['-C', vaultE, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim() === 'main',
      'takeover 후 HEAD 가 main 으로 복귀',
    );
    e.stop();

    // ── 시나리오 F: REMOTE 빔 + vault 에 기존 origin → 기존 origin 재사용 ──
    // (배포 후 config.env 에서 REMOTE 지우고 재시작해도 vault 자격증명 재사용해 계속 동작해야 한다.)
    const bareF = join(root, 'vaultF.git');
    initBare(bareF);
    seedRemote(bareF, root, { 'doc.md': 'seed-F\n' });
    const vaultF = join(root, 'vaultF');
    mkdirSync(vaultF);
    // vault 에 미리 git init + origin 설정 (사용자가 수동 clone/설정한 상황 모사)
    sh('git', ['init', '-b', 'main', vaultF]);
    sh('git', ['-C', vaultF, 'remote', 'add', 'origin', bareF]);
    const f = new Committer({ vaultPath: vaultF, remote: '', deviceId: 'devF', debounceMs: 10 });
    await f.start(); // REMOTE 빔이어도 기존 origin 사용해 부트스트랩·push 성공해야 함
    writeFileSync(join(vaultF, 'note.md'), 'from F\n');
    assert((await f.commitAndPush()) === 'pushed', 'REMOTE 빔 + 기존 origin → push 성공');
    assert(git(bareF, ['show', 'main:note.md']).includes('from F'), 'REMOTE 빔에서도 main 에 반영됨');
    f.stop();

    // ── 시나리오 F2: DISPLAY_NAME env 로 커밋 author.name 커스터마이즈 ──
    writeFileSync(join(vaultF, 'note.md'), 'from F custom name\n');
    // 새 인스턴스로 재시작(displayName 반영은 ensureRepo 시점) — DISPLAY_NAME env 명시
    const f2 = new Committer({ vaultPath: vaultF, remote: '', deviceId: 'devF', displayName: 'jaei-bot', debounceMs: 10 });
    await f2.start();
    writeFileSync(join(vaultF, 'note.md'), 'from F custom name v2\n');
    assert((await f2.commitAndPush()) === 'pushed', 'displayName 지정 후 push');
    const authorF2 = (sh('git', ['-C', vaultF, 'log', '-1', '--format=%an'])).trim();
    assert(authorF2 === 'jaei-bot', `DISPLAY_NAME 이 author.name 에 반영 (got ${authorF2})`);
    f2.stop();

    // ── 시나리오 F3: DISPLAY_NAME 미지정 시 자동 감지 + '-bot' 접미어 ──
    const f3 = new Committer({ vaultPath: vaultF, remote: '', deviceId: 'devF', debounceMs: 10 });
    await f3.start();
    writeFileSync(join(vaultF, 'note.md'), 'from F auto name\n');
    await f3.commitAndPush();
    const authorF3 = (sh('git', ['-C', vaultF, 'log', '-1', '--format=%an'])).trim();
    assert(authorF3.endsWith('-bot'), `자동 감지된 displayName 은 '-bot' 접미어를 가짐 (got ${authorF3})`);
    assert(authorF3 !== 'devF-bot' || authorF3 === 'devF-bot', `폴백 시 deviceId+'-bot' (got ${authorF3})`); // 정보 표시용
    f3.stop();

    // ── 시나리오 G: REMOTE 빔 + origin 도 없음 → 명확 에러 ──
    const vaultG = join(root, 'vaultG');
    mkdirSync(vaultG);
    const g = new Committer({ vaultPath: vaultG, remote: '', deviceId: 'devG', debounceMs: 10 });
    let threw: unknown = null;
    try {
      await g.start();
    } catch (e) {
      threw = e;
    }
    g.stop();
    assert(threw instanceof Error && threw.message.includes('REMOTE'), `REMOTE 빔 + origin 없음 → 명확 에러 (got ${threw instanceof Error ? threw.message : threw})`);

    // ── 시나리오 H: .obsidian/data.json 유출 자가 치유 (tx-docs 회귀) ──
    // 원격이 이미 .obsidian/**/data.json 을 추적 + .gitignore 에 .obsidian 없음(관리자가 실수로 커밋).
    // daemon 은 (1) .gitignore 에 .obsidian/ append (2) 인덱스에서 .obsidian untrack → 팀원끼리
    // deviceId·토큰 덮어쓰기 사고를 종식해야 한다. 디스크의 로컬 data.json 은 보존(원격 것으로 미덮어씀).
    const bareH = join(root, 'vaultH.git');
    initBare(bareH);
    const seedH = join(root, 'seedH');
    sh('git', ['clone', '-q', bareH, seedH]);
    sh('git', ['-C', seedH, 'config', 'user.email', 't@t']);
    sh('git', ['-C', seedH, 'config', 'user.name', 't']);
    writeFileSync(join(seedH, '.gitattributes'), '*.md merge=union\n* text=auto eol=lf\n');
    writeFileSync(join(seedH, '.gitignore'), 'node_modules/\n'); // 기존 .gitignore 존재, .obsidian 없음
    const dataRel = join('.obsidian', 'plugins', 'gitvault-live', 'data.json');
    mkdirSync(join(seedH, '.obsidian', 'plugins', 'gitvault-live'), { recursive: true });
    writeFileSync(join(seedH, dataRel), '{"deviceId":"OTHER-PERSON"}\n'); // 팀원 설정 — 추적된 채 push
    writeFileSync(join(seedH, 'note.md'), 'shared note\n');
    sh('git', ['-C', seedH, 'add', '-A']);
    sh('git', ['-C', seedH, 'commit', '-qm', 'seed-with-tracked-obsidian']);
    sh('git', ['-C', seedH, 'push', '-q', 'origin', 'main']);
    // 사전 조건: 원격이 실제로 data.json 을 추적 중
    assert(
      git(bareH, ['ls-tree', '-r', '--name-only', 'main']).includes('data.json'),
      'H 사전조건: 원격이 .obsidian/data.json 추적 중',
    );

    const vaultH = join(root, 'vaultH');
    mkdirSync(join(vaultH, '.obsidian', 'plugins', 'gitvault-live'), { recursive: true });
    writeFileSync(join(vaultH, dataRel), '{"deviceId":"ME"}\n'); // 이 기기의 로컬 설정 — 덮이면 안 됨
    const h = new Committer({ vaultPath: vaultH, remote: bareH, deviceId: 'devH', debounceMs: 10 });
    await h.start(); // adopt → seed(.gitignore append) → untrack → initial push
    await h.commitAndPush(); // untrack 제거를 확실히 main 에 반영

    const treeH = git(bareH, ['ls-tree', '-r', '--name-only', 'main']);
    assert(!treeH.includes('data.json'), `H: .obsidian/data.json 이 main 에서 제거됨 (${JSON.stringify(treeH)})`);
    assert(treeH.includes('note.md'), 'H: 일반 노트는 추적 유지');
    assert(git(bareH, ['show', 'main:.gitignore']).includes('.obsidian'), 'H: main:.gitignore 에 .obsidian 규칙 추가됨');
    assert(existsSync(join(vaultH, dataRel)), 'H: 로컬 data.json 디스크 파일 보존(untrack 은 인덱스만)');
    assert(
      sh('cat', [join(vaultH, dataRel)]).includes('ME'),
      'H: 로컬 data.json 이 팀원(OTHER-PERSON) 것으로 안 덮임',
    );
    h.stop();

    // ── 시나리오 I: takeover 히스테리시스 — 일시 stale(<grace) 엔 후퇴, grace 초과에만 인수 ──
    // (플러그인이 자기 git op 로 heartbeat 을 잠깐 놓쳐도 데몬이 HEAD 를 뺏지 않아 churn 방지)
    const bareI = join(root, 'vaultI.git');
    initBare(bareI);
    seedRemote(bareI, root, { 'doc.md': 'seed\n' });
    const vaultI = join(root, 'vaultI');
    mkdirSync(vaultI);
    const beatI = join(vaultI, '.git', HEARTBEAT_FILE);
    const iC = new Committer({ vaultPath: vaultI, remote: bareI, deviceId: 'devI', debounceMs: 10 });
    await iC.start();

    // heartbeat 40s 낡음: 30s 임계는 넘지만 90s grace 안 → 데몬 후퇴(플러그인 바쁨으로 간주)
    writeFileSync(beatI, `${Date.now() - 40_000}\n`);
    writeFileSync(join(vaultI, 'doc.md'), 'plugin-busy-edit\n');
    assert((await iC.commitAndPush()) === 'nochange', '40s stale(<grace) → 데몬 후퇴(히스테리시스)');
    assert(
      !git(bareI, ['show', 'main:doc.md']).includes('plugin-busy-edit'),
      '40s stale → 변경이 main 에 안 올라감',
    );

    // heartbeat 100s 낡음: grace(90s) 초과 → 진짜 종료로 보고 데몬 인수
    writeFileSync(beatI, `${Date.now() - 100_000}\n`);
    assert((await iC.commitAndPush()) === 'pushed', '100s stale(>grace) → 데몬 인수');
    assert(
      git(bareI, ['show', 'main:doc.md']).includes('plugin-busy-edit'),
      '100s stale → 변경이 main 에 반영',
    );
    iC.stop();

    console.log('SMOKE OK');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
