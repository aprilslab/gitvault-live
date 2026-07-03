import { simpleGit, SimpleGit } from 'simple-git';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PromiseQueue } from './PromiseQueue';

const IDENTITY_EMAIL_DOMAIN = 'obsidian-git-sync.local';
const GIT_BLOCK_TIMEOUT_MS = 20_000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git 빈 트리 sha (origin/main 부재 시 diff 기준)
const SUPPRESS_GRACE_MS = 2_000; // git 워킹트리 쓰기 후 vault 이벤트가 늦게 도착하는 것까지 흡수
const SAVE_RETRIES = 3;

/** origin/main 한 줄의 작성자 + author-time(unix 초). 라인 blame 거터용. */
export interface BlameLine {
  author: string;
  epoch: number;
}

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
   *
   * isStillIdle 은 워킹트리를 쓰기 직전에 재평가된다 — 느린 fetch 동안 타이핑이 재개되면
   * merge 를 다음 사이클로 연기해, 에디터 리로드가 미저장 버퍼를 날리는 TOCTOU 를 막는다.
   */
  syncDown(merge: boolean, isStillIdle: () => boolean = () => true): Promise<void> {
    return this.queue.add(async () => {
      await this.flushCommit();
      await this.git.fetch(['origin', '--prune']).catch((e) => this.log(`fetch 실패: ${redact(e)}`));
      if (!merge) return;
      if (!isStillIdle()) {
        this.log('sync-down: 타이핑 감지 — merge 연기');
        return;
      }
      // fetch 동안 들어온 입력을 디스크·커밋으로 흡수(TOCTOU 봉합). dirty 버퍼가 있었다면
      // save()가 modify 이벤트를 내 lastKeystroke 가 갱신되고, 아래 재판정이 연기시킨다.
      await this.flushCommit();
      if (!isStillIdle()) {
        this.log('sync-down: 타이핑 감지 — merge 연기');
        return;
      }
      await this.suppressed(() => this.mergeDown());
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
   * origin/main 에서의 파일 내용 (인라인 데코레이션의 diff 기준). ref 나 파일이 없으면 null.
   * path 는 vault(=repo) 상대경로.
   * read-only 라 PromiseQueue 를 우회한다 — 느린 fetch/merge 뒤에서 대기하지 않아 하이라이트가 즉시 반영된다.
   */
  async mainFileContent(path: string): Promise<string | null> {
    if (!(await this.refExists('refs/remotes/origin/main'))) return null;
    try {
      return await this.git.raw(['show', `origin/main:${path}`]);
    } catch {
      return null; // origin/main 에 없는 파일(신규 노트 등)
    }
  }

  /**
   * origin/main 에서 이 파일을 마지막으로 커밋한 작성자(=참여자 deviceId). "누가 작성 중" 표시용.
   * read-only 라 큐 우회. ref/파일 없으면 null.
   */
  async mainAuthor(path: string): Promise<string | null> {
    if (!(await this.refExists('refs/remotes/origin/main'))) return null;
    try {
      const out = (await this.git.raw(['log', '-1', '--format=%an', 'origin/main', '--', path])).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  /**
   * origin/main 각 라인의 작성자를 "라인내용 → 작성자" 맵으로. 라인별 "누가 작성 중" 표시용.
   * (인메모리 diff 의 removedLines 텍스트로 조회 — 중복 라인은 마지막 작성자.) read-only, 큐 우회.
   */
  async mainBlame(path: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!(await this.refExists('refs/remotes/origin/main'))) return map;
    try {
      const out = await this.git.raw(['blame', '--line-porcelain', 'origin/main', '--', path]);
      let author = '';
      for (const line of out.split('\n')) {
        if (line.startsWith('author ')) author = line.slice(7);
        else if (line.startsWith('\t')) map.set(line.slice(1), author);
      }
    } catch {
      /* ref/파일 없음 — 빈 맵 */
    }
    return map;
  }

  /**
   * origin/main 각 줄의 작성자+author-time 을 줄번호순 배열로. GitLens식 라인 blame 거터용.
   * (내용 아닌 위치 기반 — 중복 줄 안전.) read-only, 큐 우회. ref/파일 없으면 빈 배열.
   */
  async mainBlameLines(path: string): Promise<BlameLine[]> {
    if (!(await this.refExists('refs/remotes/origin/main'))) return [];
    try {
      const out = await this.git.raw(['blame', '--line-porcelain', 'origin/main', '--', path]);
      const lines: BlameLine[] = [];
      let author = '';
      let epoch = 0;
      for (const line of out.split('\n')) {
        if (line.startsWith('author ')) author = line.slice(7);
        else if (line.startsWith('author-time ')) epoch = Number(line.slice(12)) || 0;
        else if (line.startsWith('\t')) lines.push({ author, epoch });
      }
      return lines;
    } catch {
      return []; // ref/파일 없음
    }
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
    await this.suppressed(async () => {
      await this.ensureWipBranch();
      // 모든 경로(adopt/기존 wip/빈 원격 seed)에서 union 드라이버를 보장 — 없으면 .md 충돌이
      // -X theirs(원격 승)로 떨어져 로컬 편집이 조용히 소실된다. writeIfAbsent 라 기존 파일은 존중.
      this.seedRepoFiles();
    });
    this.warnIfNoUnion();
  }

  /** 기존 .gitattributes 에 union 드라이버가 없으면 경고만(공유 설정 파일이라 내용 변조는 안 함). */
  private warnIfNoUnion(): void {
    try {
      const content = readFileSync(join(this.opts.basePath, '.gitattributes'), 'utf8');
      if (!content.includes('merge=union')) {
        this.log('.gitattributes 에 merge=union 없음 — .md 동시 편집 충돌 시 원격이 우선됩니다');
      }
    } catch {
      /* 파일 없음 — seedRepoFiles 가 방금 생성했으므로 도달하지 않음 */
    }
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
      // seed 파일은 ensureRepoLocked 가 모든 경로 공통으로 생성한다.
    }
  }

  /** seed 파일 보장: .gitattributes(union) + .gitignore. 기존 파일은 존중(wx). 모든 연결 경로에서 호출. */
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
