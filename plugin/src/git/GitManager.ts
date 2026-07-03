import { simpleGit, SimpleGit } from 'simple-git';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { PromiseQueue } from './PromiseQueue';

const IDENTITY_EMAIL_DOMAIN = 'obsidian-git-sync.local';
const GIT_BLOCK_TIMEOUT_MS = 20_000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git 빈 트리 sha (origin/main 부재 시 diff 기준)
const SUPPRESS_GRACE_MS = 2_000; // git 워킹트리 쓰기 후 vault 이벤트가 늦게 도착하는 것까지 흡수
const SAVE_RETRIES = 3;

export interface GitManagerOptions {
  /** vault 워킹트리 절대경로 (FileSystemAdapter.getBasePath()). */
  basePath: string;
  /** 인증이 포함된 remote URL (https://<user>:<token>@host/path.git). 로그에 노출 금지. */
  authedRemote: string;
  /** 커밋 identity 및 wip 브랜치 이름에 쓰이는 안정적 기기 식별자. */
  deviceId: string;
  /** commit/merge 직전 열린 에디터의 미저장 버퍼를 디스크로 flush. AutoSync 가 주입. */
  flushEditors?: () => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * 플러그인용 vault git 클라이언트 (원본 daemon committer 의 wip/squash 모델 이식).
 * - commitAndPushWip: 편집 → wip/<device> 커밋·푸시
 * - syncDown: origin/main → wip union 병합 (타 참여자 변경 수신)
 * - squashMergeToMain: wip 를 origin/main 위 1커밋으로 squash (checkout 없는 plumbing)
 *
 * 불변식: 로컬 main 없음(항상 wip 체크아웃). 모든 git op 는 PromiseQueue 로 직렬화.
 * 워킹트리를 쓰는 op(merge/adopt)는 suppress 로 감싸 이벤트 피드백 루프를 차단한다.
 */
export class GitManager {
  private readonly git: SimpleGit;
  private readonly queue = new PromiseQueue();
  private readonly deviceId: string;
  private readonly wipRef: string;
  private readonly flushEditors: () => Promise<void>;
  private readonly log: (msg: string) => void;

  private suppressDepth = 0;
  private suppressGraceUntil = 0;

  constructor(private readonly opts: GitManagerOptions) {
    this.git = simpleGit(opts.basePath, { timeout: { block: GIT_BLOCK_TIMEOUT_MS } });
    this.deviceId = opts.deviceId;
    this.wipRef = `wip/${opts.deviceId}`;
    this.flushEditors = opts.flushEditors ?? (async () => undefined);
    this.log = opts.log ?? (() => undefined);
  }

  /** git 이 워킹트리를 방금 건드렸는가 — AutoSync 가 vault 이벤트를 드롭할지 판단. */
  get eventsSuppressed(): boolean {
    return this.suppressDepth > 0 || Date.now() < this.suppressGraceUntil;
  }

  get device(): string {
    return this.deviceId;
  }

  /** repo 보장: init/clone, identity·quotePath 설정, remote 갱신, wip 체크아웃(adopt/seed). */
  ensureRepo(): Promise<void> {
    return this.queue.add(() => this.ensureRepoLocked());
  }

  /** wip/<device> 로 커밋·푸시 (직렬화). */
  commitAndPushWip(): Promise<'pushed' | 'nochange'> {
    return this.queue.add(async () => {
      const committed = await this.flushCommit();
      await this.pushWip();
      return committed ? 'pushed' : 'nochange';
    });
  }

  /**
   * sync-down: flush + fetch (+ 선택적 merge).
   * merge=false 면 origin/* 갱신만(패널·데코레이션용) — 타이핑 중 워킹트리를 건드리지 않는다.
   * merge=true 면 origin/main 을 wip 로 union 병합(idle 에만 호출).
   */
  syncDown(merge: boolean): Promise<void> {
    return this.queue.add(async () => {
      await this.flushEditors();
      await this.flushCommit();
      await this.git.fetch(['origin', '--prune']).catch((e) => this.log(`fetch 실패: ${redact(e)}`));
      if (merge) await this.suppressed(() => this.mergeDown());
    });
  }

  /** 저장: sync-down 후 merged tree 를 origin/main 위 1커밋으로 push (checkout 없음). */
  squashMergeToMain(): Promise<'saved' | 'nochange'> {
    return this.queue.add(() => this.saveLocked());
  }

  /** origin/main 커밋 sha (없으면 null). */
  originMain(): Promise<string | null> {
    return this.queue.add(async () => {
      await this.git.fetch(['origin', '--prune']).catch(() => undefined);
      return (await this.refExists('refs/remotes/origin/main'))
        ? (await this.git.raw(['rev-parse', 'origin/main'])).trim()
        : null;
    });
  }

  /** 두 트리 사이 변경 파일 목록 (`git diff --name-status a b`). Phase C 패널/데코레이션용. */
  changedFiles(a: string, b: string): Promise<Array<{ status: string; path: string }>> {
    return this.queue.add(async () => {
      const out = await this.git.raw(['diff', '--name-status', '-z', a, b]).catch(() => '');
      return parseNameStatusZ(out);
    });
  }

  /**
   * 저장 시 origin/main 에 반영될 변경 파일 (저장 미리보기).
   * - origin/main 이 없으면 empty-tree 기준(첫 발행 부트스트랩) — 모든 추적 파일이 대상.
   * - 아직 커밋 안 된 신규 노트(untracked)도 포함 — 저장(flushCommit=add -A)이 발행할 내용과 일치시킨다.
   */
  outgoingFiles(): Promise<Array<{ status: string; path: string }>> {
    return this.queue.add(async () => {
      const base = (await this.refExists('refs/remotes/origin/main')) ? 'origin/main' : EMPTY_TREE;
      const diff = await this.git.raw(['diff', '--name-status', '-z', base]).catch(() => '');
      const tracked = parseNameStatusZ(diff);
      const seen = new Set(tracked.map((f) => f.path));
      const othersZ = await this.git.raw(['ls-files', '--others', '--exclude-standard', '-z']).catch(() => '');
      const untracked = othersZ
        .split('\0')
        .filter((p) => p.length > 0 && !seen.has(p))
        .map((path) => ({ status: 'A', path }));
      return [...tracked, ...untracked];
    });
  }

  /**
   * 아직 내 wip 에 병합되지 않은 origin/main 의 변경 파일 (타 참여자 도착분).
   * merge-base(HEAD, origin/main) → origin/main diff 이므로, 내가 이미 병합한 변경은 제외된다.
   */
  incomingFiles(): Promise<Array<{ status: string; path: string }>> {
    return this.queue.add(async () => {
      const base = await this.mergeBaseMain();
      if (!base) return [];
      const out = await this.git.raw(['diff', '--name-status', '-z', base, 'origin/main']).catch(() => '');
      return parseNameStatusZ(out);
    });
  }

  /**
   * 활성 파일의 origin/main(old) 대비 로컬 워킹트리(new) unified diff (U0, context 0).
   * CollabDecorations 의 hunk 파싱 소스. path 는 vault(=repo) 상대경로.
   */
  fileDiffVsMain(path: string): Promise<string> {
    return this.queue.add(async () => {
      if (!(await this.refExists('refs/remotes/origin/main'))) return '';
      return this.git.raw(['diff', '--no-color', '-U0', 'origin/main', '--', path]).catch(() => '');
    });
  }

  private async mergeBaseMain(): Promise<string | null> {
    if (!(await this.refExists('refs/remotes/origin/main'))) return null;
    try {
      return (await this.git.raw(['merge-base', 'HEAD', 'origin/main'])).trim() || null;
    } catch {
      return null;
    }
  }

  // ── 내부 ──────────────────────────────────────────────────────────────

  private async ensureRepoLocked(): Promise<void> {
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (!isRepo) await this.git.init();

    await this.git.addConfig('user.name', this.deviceId);
    await this.git.addConfig('user.email', `${this.deviceId}@${IDENTITY_EMAIL_DOMAIN}`);
    // 비-ASCII(한글) 파일명이 status 에서 C-quote 되지 않도록 — 파싱/pathspec 정확성 필수.
    await this.git.addConfig('core.quotePath', 'false');

    const remotes = await this.git.getRemotes(true).catch(() => []);
    if (!remotes.find((r) => r.name === 'origin')) {
      await this.git.raw(['remote', 'add', 'origin', this.opts.authedRemote]);
    } else {
      await this.git.raw(['remote', 'set-url', 'origin', this.opts.authedRemote]);
    }
    await this.git.fetch(['origin', '--prune']).catch((e) => this.log(`초기 fetch 실패: ${redact(e)}`));
    await this.suppressed(() => this.ensureWipBranch());
  }

  private async ensureWipBranch(): Promise<void> {
    const local = await this.git.branchLocal().catch(() => ({ all: [] as string[] }));
    if (local.all.includes(this.wipRef)) {
      await this.git.raw(['checkout', this.wipRef]);
      return;
    }
    if (await this.refExists('refs/remotes/origin/main')) {
      // origin/main 위에 wip 을 만들되 워킹트리를 덮지 않는다(기존 vault 온보딩 크래시 방지).
      // 로컬 파일은 index 로 흡수, 원격 전용 파일만 워킹트리로 실체화.
      await this.git.raw(['branch', '-f', this.wipRef, 'origin/main']);
      await this.git.raw(['symbolic-ref', 'HEAD', `refs/heads/${this.wipRef}`]);
      await this.git.raw(['reset', '--mixed']);
      await this.git.raw(['add', '--ignore-removal', '--', '.']);
      const status = await this.git.raw(['status', '--porcelain']);
      if (status.trim()) await this.git.commit(`adopt: ${nowIso()}`);
      await this.git.raw(['checkout-index', '-a']);
    } else {
      await this.git.raw(['checkout', '-B', this.wipRef]);
      this.seedRepoFiles();
    }
  }

  /** 빈 원격 seed: .gitattributes(union) + .gitignore. 기존 파일은 존중. */
  private seedRepoFiles(): void {
    writeIfAbsent(this.opts.basePath, '.gitattributes', '*.md merge=union\n* text=auto eol=lf\n');
    writeIfAbsent(this.opts.basePath, '.gitignore', '.obsidian/\n.DS_Store\nThumbs.db\n');
  }

  /** flush: 에디터 저장 → add -A → 변경 없으면 skip(이벤트 루프 종결자), 있으면 커밋. 커밋 여부 반환. */
  private async flushCommit(): Promise<boolean> {
    await this.flushEditors();
    await this.git.add(['-A']);
    const status = await this.git.raw(['status', '--porcelain']);
    if (!status.trim()) return false;
    await this.git.commit(`${this.deviceId}: ${nowIso()}`);
    return true;
  }

  private async pushWip(): Promise<void> {
    const spec = `HEAD:refs/heads/${this.wipRef}`;
    try {
      await this.git.raw(['push', 'origin', spec]); // 평시 fast-forward
    } catch {
      // 저장 후 reset --soft 한 wip 은 원격과 sibling(비-ff) → force-with-lease 로 재정렬.
      // 단일 작성자 전제라 lease 어긋나면(타 작성자) 시끄럽게 실패하는 게 옳다.
      await this.git.raw(['push', '--force-with-lease', 'origin', spec]);
    }
  }

  /** origin/main 을 wip 로 병합. .md 는 union, 그 외 -X theirs. 잔여 충돌은 폴백. */
  private async mergeDown(): Promise<void> {
    if (!(await this.refExists('refs/remotes/origin/main'))) return;
    try {
      await this.git.raw(['merge', '-X', 'theirs', '--no-edit', 'origin/main']);
    } catch {
      await this.resolveModifyDelete();
    }
  }

  /** modify/delete 잔여 충돌: "수정이 삭제를 이긴다". 해소 불가 시 abort + throw. */
  private async resolveModifyDelete(): Promise<void> {
    const status = await this.git.raw(['status', '--porcelain']);
    for (const line of status.split('\n')) {
      if (!line.trim()) continue;
      const xy = line.slice(0, 2);
      const path = line.slice(3).trim();
      if (xy === 'UD') {
        await this.git.raw(['add', '--', path]); // 우리 수정 유지
      } else if (xy === 'DU') {
        await this.git.raw(['checkout', '--theirs', '--', path]);
        await this.git.raw(['add', '--', path]); // 상대 수정 복원
      }
    }
    const remaining = (await this.git.raw(['diff', '--name-only', '--diff-filter=U'])).trim();
    if (remaining) {
      await this.git.raw(['merge', '--abort']);
      throw new Error(`sync-down 충돌 미해소: ${remaining}`);
    }
    await this.git.commit(`sync-down: ${nowIso()}`);
  }

  private async saveLocked(): Promise<'saved' | 'nochange'> {
    await this.flushCommit();
    for (let attempt = 0; attempt < SAVE_RETRIES; attempt++) {
      await this.git.fetch(['origin', '--prune']).catch(() => undefined);
      await this.suppressed(() => this.mergeDown());

      const tree = (await this.git.raw(['rev-parse', 'HEAD^{tree}'])).trim();
      const mainTree = (await this.refExists('refs/remotes/origin/main'))
        ? (await this.git.raw(['rev-parse', 'origin/main^{tree}'])).trim()
        : null;
      if (tree === mainTree) return 'nochange'; // 변경 없음 → 빈 저장 방지

      const parent = mainTree ? ['-p', 'origin/main'] : [];
      const msg = `저장: ${this.deviceId} ${nowIso()}`;
      const commit = (await this.git.raw(['commit-tree', tree, ...parent, '-m', msg])).trim();

      try {
        await this.git.raw(['push', 'origin', `${commit}:refs/heads/main`]);
      } catch (e) {
        if (attempt === SAVE_RETRIES - 1) throw e;
        await sleep(100 + Math.floor(Math.random() * 400)); // jitter 후 fetch 부터 재시도
        continue;
      }

      await this.git.raw(['reset', '--soft', commit]); // wip 포인터만 이동, 워킹트리·mtime 무변경
      await this.pushWip();
      return 'saved';
    }
    return 'nochange';
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      // simple-git 은 `--quiet` 로 exit 1 이어도 throw 없이 빈 문자열을 resolve → sha 유무로 판정.
      const out = await this.git.raw(['rev-parse', '--verify', '--quiet', ref]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async suppressed<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressDepth++;
    try {
      return await fn();
    } finally {
      this.suppressDepth--;
      this.suppressGraceUntil = Date.now() + SUPPRESS_GRACE_MS;
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/** 에러 메시지에서 remote URL 의 자격증명(<user>:<token>@)을 마스킹. */
function redact(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\/\/[^/@\s]+@/g, '//***@');
}

function parseNameStatusZ(z: string): Array<{ status: string; path: string }> {
  // `-z` NUL 구분: status\0path\0status\0path... (rename 은 status\0old\0new — new 를 채택)
  const parts = z.split('\0').filter((s) => s.length > 0);
  const out: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (status[0] === 'R' || status[0] === 'C') {
      const newPath = parts[i + 1];
      i += 2;
      if (newPath) out.push({ status, path: newPath });
    } else {
      const path = parts[i++];
      if (path) out.push({ status, path });
    }
  }
  return out;
}

function writeIfAbsent(base: string, name: string, content: string): void {
  try {
    writeFileSync(join(base, name), content, { flag: 'wx' });
  } catch {
    /* 이미 있으면 존중 */
  }
}
