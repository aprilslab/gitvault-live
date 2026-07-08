import { simpleGit, SimpleGit } from 'simple-git';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PromiseQueue } from './PromiseQueue';
import { isStalePeer } from '../editor/peerPresence';

const IDENTITY_EMAIL_DOMAIN = 'gitvault-live.local';
const GIT_BLOCK_TIMEOUT_MS = 20_000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git 빈 트리 sha (origin/main 부재 시 diff 기준)
const SUPPRESS_GRACE_MS = 2_000; // git 워킹트리 쓰기 후 vault 이벤트가 늦게 도착하는 것까지 흡수
const SAVE_RETRIES = 3;

/** origin/main 한 줄의 작성자 + author-time(unix 초). 라인 blame 거터용. */
export interface BlameLine {
  author: string;
  epoch: number;
}

/** 타 참여자의 진행 중 wip 브랜치. presence 배지 소스. */
export interface PeerWip {
  ref: string; // 예: 'origin/wip/dev-B/123'
  device: string; // 브랜치명의 device 세그먼트(자기-제외 판정용)
  author: string; // 마지막 커밋 author.name = 상대 displayName
}

/** 한 파일의 커밋 이력 항목. 이력 패널용. */
export interface FileCommit {
  hash: string; // 전체 SHA (fileAtCommit 조회용)
  shortHash: string; // 축약 SHA (표시용)
  author: string;
  date: string; // 로컬 시각 문자열
  subject: string; // 커밋 제목
}

export interface GitManagerOptions {
  /** vault 워킹트리 절대경로 (FileSystemAdapter.getBasePath()). */
  basePath: string;
  /** 인증이 포함된 remote URL (https://<user>:<token>@host/path.git). 로그에 노출 금지. 토큰 없으면 인증 없는 평문 URL(또는 빈 문자열=기존 origin 사용). */
  authedRemote: string;
  /** true(토큰 입력됨)면 기존 origin 을 authedRemote 로 덮어쓴다. false면 기존 origin 보존 — 이 기기의 git 자격증명(credential helper·SSH·이미 박힌 토큰)을 재사용. */
  bakeCredentials?: boolean;
  /** 커밋 identity 및 wip 브랜치 이름에 쓰이는 안정적 기기 식별자. */
  deviceId: string;
  /** 협업 표시이름(커밋 author.name). 비우면 deviceId. */
  displayName?: string;
  /** commit/merge 직전 열린 에디터의 미저장 버퍼를 디스크로 flush. AutoSync 가 주입. */
  flushEditors?: () => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * 플러그인용 vault git 클라이언트 (ephemeral wip 생명주기 모델).
 * - commitAndPushWip: 편집 → 세션 wip(`wip/<device>/<ts>`) lazy-fork 커밋·푸시
 * - syncDown: origin/main → (편집중이면 wip union / idle 이면 ff) 병합 (타 참여자 변경 수신)
 * - squashMergeToMain: merged tree 를 origin/main 위 1커밋으로 squash push 후 main 으로 복귀·wip 삭제
 *
 * 세션 상태(`currentWip`): null=idle(로컬 `main` 체크아웃), 문자열=편집중(그 wip 체크아웃).
 * 로드 시 origin/main 위로 main 을 맞추고(워킹트리 보존) 자기 소유 wip(레거시·잔여 세션)를 정리한다.
 * 모든 git op 는 PromiseQueue 로 직렬화. 워킹트리를 쓰는 op(merge/adopt/main 전환)는 suppress 로
 * 감싸 이벤트 피드백 루프를 차단한다.
 */
export class GitManager {
  private readonly git: SimpleGit;
  private readonly queue = new PromiseQueue();
  private readonly deviceId: string;
  private readonly displayName: string;
  private readonly flushEditors: () => Promise<void>;
  private readonly log: (msg: string) => void;

  /** 세션 상태: null=idle(로컬 main), 문자열=편집중 wip 브랜치명. */
  private currentWip: string | null = null;
  /** 현재 wip 이 원격에 push 되었는가 — finishToMain 이 존재하지 않는 원격 브랜치를 delete 하려다 에러 로그 내는 것 방지. */
  private wipPushed = false;

  private suppressDepth = 0;
  private suppressGraceUntil = 0;

  constructor(private readonly opts: GitManagerOptions) {
    this.git = simpleGit(opts.basePath, { timeout: { block: GIT_BLOCK_TIMEOUT_MS } });
    this.deviceId = opts.deviceId;
    this.displayName = opts.displayName?.trim() || opts.deviceId;
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

  /** repo 보장: init/clone, identity·quotePath 설정, remote 갱신, main 정렬(adopt/seed) + 자기 wip 정리. */
  ensureRepo(): Promise<void> {
    return this.queue.add(() => this.ensureRepoLocked());
  }

  /** 세션 wip(`wip/<device>/<ts>`, 최초 변경 시 fork)로 커밋·푸시 (직렬화). */
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
   * 한 파일의 커밋 이력 (최신순). 저장 이력을 보여주는 ref 우선: 로컬 main → origin/main → HEAD.
   * (wip 브랜치의 자잘한 자동커밋 노이즈를 피하려 main 을 기준으로 삼는다.)
   * read-only 라 큐 우회. ref/파일 없으면 빈 배열.
   */
  async fileHistory(path: string, limit = 50): Promise<FileCommit[]> {
    const ref = (await this.refExists('refs/heads/main'))
      ? 'main'
      : (await this.refExists('refs/remotes/origin/main'))
        ? 'origin/main'
        : 'HEAD';
    try {
      // NUL 구분자로 안전 파싱 (제목·이름에 공백/특수문자 있어도 됨).
      const fmt = '%H%x00%h%x00%an%x00%ad%x00%s';
      const out = await this.git.raw([
        'log',
        `--format=${fmt}`,
        '--date=format-local:%Y-%m-%d %H:%M',
        '-n',
        String(limit),
        ref,
        '--',
        path,
      ]);
      return out
        .split('\n')
        .filter((l) => l.length > 0)
        .map((line) => {
          const [hash, shortHash, author, date, subject = ''] = line.split('\0');
          return { hash, shortHash, author, date, subject };
        });
    } catch {
      return [];
    }
  }

  /** 특정 커밋 시점의 파일 내용 (`git show <hash>:<path>`). 없으면 null. read-only, 큐 우회. */
  async fileAtCommit(hash: string, path: string): Promise<string | null> {
    try {
      return await this.git.raw(['show', `${hash}:${path}`]);
    } catch {
      return null; // 그 커밋에 해당 파일 없음(이후 생성/이전 삭제 등)
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

  /**
   * 타 참여자의 진행 중 wip 브랜치 목록(자기 제외 + staleness 필터).
   * `origin/wip/<device>/<ts>` 만 대상 — 레거시 `origin/wip/<device>`(ts 없음)는 제외.
   */
  async listPeerWips(): Promise<PeerWip[]> {
    const remote = await this.git.branch(['-r']).catch(() => ({ all: [] as string[] }));
    const now = Date.now();
    const out: PeerWip[] = [];
    for (const r of remote.all) {
      const name = r.replace(/^origin\//, '');
      const m = /^wip\/([^/]+)\/\d+$/.exec(name); // wip/<device>/<ts>
      if (!m) continue;
      const device = m[1];
      if (device === this.deviceId) continue; // 자기 제외
      try {
        const raw = (await this.git.raw(['log', '-1', '--format=%ct%x00%an', r])).trim();
        const [ctStr, author = ''] = raw.split('\0');
        const ct = Number(ctStr); // epoch 초 (isStalePeer 가 초를 받는다)
        if (isStalePeer(ct, now)) continue; // stale 제외
        out.push({ ref: r, device, author });
      } catch {
        /* 브랜치가 방금 삭제됨 등 — skip */
      }
    }
    return out;
  }

  /** peer wip 브랜치의 파일 내용(`git show <ref>:<path>`). 없으면 null. */
  async peerWipContent(ref: string, path: string): Promise<string | null> {
    try {
      return await this.git.raw(['show', `${ref}:${path}`]);
    } catch {
      return null;
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

    await this.git.addConfig('user.name', this.displayName);
    await this.git.addConfig('user.email', `${this.deviceId}@${IDENTITY_EMAIL_DOMAIN}`);
    // 비-ASCII(한글) 파일명이 status 에서 C-quote 되지 않도록 — 파싱/pathspec 정확성 필수.
    await this.git.addConfig('core.quotePath', 'false');

    const remotes = await this.git.getRemotes(true).catch(() => []);
    const hasOrigin = !!remotes.find((r) => r.name === 'origin');
    if (this.opts.authedRemote) {
      if (!hasOrigin) {
        await this.git.raw(['remote', 'add', 'origin', this.opts.authedRemote]);
      } else if (this.opts.bakeCredentials) {
        await this.git.raw(['remote', 'set-url', 'origin', this.opts.authedRemote]); // 토큰 입력됨 → 자격증명 갱신
      }
      // else: origin 존재 + 토큰 없음 → 기존 origin 보존(SSH/credential helper/이미 박힌 토큰 재사용)
    } else if (!hasOrigin) {
      throw new Error('저장소 URL 또는 vault 의 기존 git origin 이 필요합니다');
    }
    await this.git.fetch(['origin', '--prune']).catch((e) => this.log(`초기 fetch 실패: ${redact(e)}`));
    await this.suppressed(async () => {
      // ensureOnMain 이 내부에서 seedRepoFiles() 를 호출한다 — 원격 파일 실체화(checkout-index) '이후',
      // add/status '이전'. 그래야 (1) .gitignore 가 add 전에 있어 .obsidian/ 이 adopt 커밋에 새지 않고,
      // (2) 원격이 가진 커스텀 .gitattributes 를 seed 가 덮지 않는다(writeIfAbsent + 실체화 선행).
      // 모든 경로(adopt/빈 원격 seed/idle)에서 union 드라이버가 보장돼 .md 충돌 시 로컬 편집 소실을 막는다.
      // [CRITICAL] deleteOwnWips() 는 ensureOnMain() *내부에서*, adopt 가 세션 wip 을 fork 하기 '전'에
      // 호출된다(HEAD 가 main 에 올라간 직후) — 그래야 레거시 영속 브랜치 `wip/<device>` 가 남아있는 상태로
      // `checkout -b wip/<device>/<ts>` 를 시도해 D/F(ref 디렉토리/파일) 충돌로 실패하는 일이 없다.
      await this.ensureOnMain();
    });
    this.warnIfNoUnion();
  }

  /** 세션 유니크 wip 브랜치명. */
  private newWipRef(): string {
    return `wip/${this.deviceId}/${Date.now()}`;
  }

  /** 자기 소유 wip(영속 `wip/<device>` + ts형 `wip/<device>/*`) 로컬·원격 삭제. best-effort. */
  private async deleteOwnWips(): Promise<void> {
    const own = `wip/${this.deviceId}`;
    const isOwn = (name: string): boolean => name === own || name.startsWith(`${own}/`);
    const localBranches = await this.git.branchLocal().catch(() => ({ all: [] as string[] }));
    for (const b of localBranches.all) {
      // 현재 체크아웃 브랜치(adopt 세션 wip)는 `branch -D` 가 실패 → catch 로 살아남음(의도).
      if (isOwn(b)) await this.git.raw(['branch', '-D', b]).catch(() => undefined);
    }
    const remote = await this.git.branch(['-r']).catch(() => ({ all: [] as string[] }));
    for (const r of remote.all) {
      const name = r.replace(/^origin\//, '');
      if (isOwn(name)) {
        await this.git.raw(['push', 'origin', '--delete', name]).catch((e) => this.log(`원격 wip 삭제 실패: ${redact(e)}`));
      }
    }
  }

  /**
   * origin/main 위로 세션 상태 결정 (워킹트리 보존).
   *
   * [CRITICAL] 로컬 변경 유무를 origin/main 이 아니라 "마지막으로 동기화된 base(=oldMain)" 기준으로 판정한다.
   * 방금 fetch 한 origin/main 으로 main 을 먼저 advance 한 뒤 status 를 보면, 앱이 닫힌 사이 팀원이 저장해
   * origin/main 만 앞선 clean-behind 재연결이 "로컬 미저장 편집" 으로 오탐된다 → origin/main 을 base 로 삼는
   * adopt wip 은 mergeDown 에서 origin/main 을 조상으로 보아 no-op 이 되고, 이어진 저장이 stale tree 로
   * origin/main 을 덮어 팀원 저장분이 조용히 유실된다. 그래서 advance 전(oldMain) 기준으로 dirty 를 판정한다.
   *
   * 불변식: idle main 은 미푸시 로컬 커밋을 갖지 않는다(저장은 항상 squash 를 origin/main 에 push 하고 main 을
   * 거기로 이동). 따라서 oldMain 은 언제나 origin/main 의 조상 → clean 케이스의 `merge --ff-only` 는 항상 성공.
   *
   * seedRepoFiles() 는 원격 파일 실체화(checkout-index) 이후·add 이전에 호출 — 원격의 커스텀 .gitattributes 를
   * 존중하고 .gitignore 를 add 전에 배치한다.
   */
  private async ensureOnMain(): Promise<void> {
    if (!(await this.refExists('refs/remotes/origin/main'))) {
      await this.git.raw(['checkout', '-B', 'main']); // 빈 원격 부트스트랩
      await this.deleteOwnWips(); // fork 전 레거시 wip 제거(D/F 충돌 방지) — main 체크아웃 직후라 안전
      this.seedRepoFiles(); // 원격이 없으니 존중할 대상도 없음 — union 드라이버 즉시 시드
      this.currentWip = null;
      this.wipPushed = false;
      return;
    }
    // base = 마지막으로 동기화된 상태. 로컬 main 이 있으면 그것을 advance 하지 않고 HEAD 만 올려
    // clean-behind 재연결에서 origin/main 앞섬을 로컬 편집으로 오판하지 않게 한다. 워킹트리는 두 경로 모두 보존.
    const hasLocalMain = await this.refExists('refs/heads/main');
    if (hasLocalMain) {
      await this.git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
      await this.git.raw(['reset', '--mixed']); // index=oldMain, 워킹트리 불변 (advance 하지 않음)
    } else {
      await this.git.raw(['branch', 'main', 'origin/main']); // 첫 클론/최초 실행: base=origin/main
      await this.git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
      await this.git.raw(['reset', '--mixed', 'origin/main']);
    }
    // [CRITICAL] HEAD 가 main 위(어느 wip 도 아님)인 지금 레거시 wip/<device> 를 지운다 — 아래
    // dirty 판정에서 adopt 로 갈 경우 `checkout -b wip/<device>/<ts>` 가 fork 되는데, 레거시 영속
    // 브랜치 `wip/<device>` 가 그때까지 남아 있으면 git 이 'refs/heads/wip/<device>' 와
    // 'refs/heads/wip/<device>/<ts>' 를 동시에 가질 수 없어(D/F 충돌) fork 가 fatal 로 실패한다.
    // branch -D/push --delete 는 인덱스·워킹트리를 건드리지 않으므로 아래 dirty 판정(oldMain 기준)에
    // 영향 없다.
    await this.deleteOwnWips();
    // 원격 전용/누락 파일 실체화 — no -f 라 디스크에 이미 있는 파일은 건너뛴다(유저 편집 및 원격 커스텀 config 보존).
    // exit 1(덮을 게 있음)도 정상 흐름이므로 삼킨다.
    await this.git.raw(['checkout-index', '-a']).catch(() => undefined);
    // 원격 파일 실체화 '이후' seed: 원격이 가진 .gitattributes 는 존중되고, .gitignore 는 아래 add 전에 놓인다.
    this.seedRepoFiles();
    // 로컬 신규/수정만 stage(삭제는 무시) → dirty 는 이제 base(oldMain) 기준.
    // [알려진 한계] 미저장 로컬 파일 '삭제' 는 재연결 시 보존되지 않는다 — 의도적: 대량 삭제가
    // origin/main 으로 전파돼 팀원 파일을 지우는 것을 막기 위함(수정/신규만 adopt).
    await this.git.raw(['add', '--ignore-removal', '--', '.']);
    const dirty = (await this.git.raw(['status', '--porcelain'])).trim().length > 0;
    if (!dirty) {
      // 디스크==base. base 가 origin/main 보다 뒤(팀원이 저장)일 수 있으므로 ff-only 로 그 변경을 디스크에 실체화.
      await this.git.raw(['merge', '--ff-only', 'origin/main']).catch(() => undefined);
      this.currentWip = null;
      this.wipPushed = false;
    } else {
      // base 위 진짜 로컬 편집 → adopt: base(현 HEAD=oldMain)에서 wip fork. origin/main 으로 advance 하지 않는다.
      // 다음 mergeDown(currentWip≠null → merge -X theirs origin/main)이 팀원의 동시 변경과 내 편집을 3-way union.
      this.currentWip = this.newWipRef();
      this.wipPushed = false;
      await this.git.raw(['checkout', '-b', this.currentWip]);
      await this.git.commit(`adopt: ${nowIso()}`);
    }
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

  /** seed 파일 보장: .gitattributes(union) + .gitignore. 기존 파일은 존중(wx). 모든 연결 경로에서 호출. */
  private seedRepoFiles(): void {
    writeIfAbsent(this.opts.basePath, '.gitattributes', '*.md merge=union\n* text=auto eol=lf\n');
    writeIfAbsent(this.opts.basePath, '.gitignore', '.obsidian/\n.DS_Store\nThumbs.db\n');
  }

  /**
   * flush: 에디터 저장 → add -A → 변경 없으면 skip(이벤트 루프 종결자), 있으면 커밋. 커밋 여부 반환.
   * 첫 변경(currentWip===null)이면 현 HEAD(main) 기준으로 세션 wip 을 lazy-fork 한다.
   */
  private async flushCommit(): Promise<boolean> {
    await this.flushEditors();
    await this.git.add(['-A']);
    const status = await this.git.raw(['status', '--porcelain']);
    if (!status.trim()) return false;
    if (this.currentWip === null) {
      this.currentWip = this.newWipRef();
      this.wipPushed = false; // 새 wip — 아직 원격에 없음
      await this.git.raw(['checkout', '-b', this.currentWip]); // 현 HEAD(main) 기준 fork
    }
    await this.git.commit(`${this.deviceId}: ${nowIso()}`);
    return true;
  }

  /** 세션 wip 을 원격에 push. idle(변경 전무)이면 no-op. 유니크 세션 브랜치라 평범한 push. */
  private async pushWip(): Promise<void> {
    if (this.currentWip === null) return;
    await this.git.raw(['push', 'origin', `HEAD:refs/heads/${this.currentWip}`]);
    this.wipPushed = true; // 원격에 존재 확정 — finishToMain 의 원격 delete 를 허용
  }

  /**
   * origin/main 을 아래로 병합.
   * - idle(currentWip null): 로컬 커밋이 없어 `merge --ff-only` 로 origin/main 을 그대로 따라간다.
   * - 편집중: wip 로 union 병합(.md union, 그 외 -X theirs). 잔여 충돌은 폴백.
   */
  private async mergeDown(): Promise<void> {
    if (!(await this.refExists('refs/remotes/origin/main'))) return;
    if (this.currentWip === null) {
      await this.git.raw(['merge', '--ff-only', 'origin/main']).catch(() => undefined); // idle: 로컬 커밋 없어 ff
      return;
    }
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
    if (this.currentWip === null) return 'nochange'; // 편집 전무
    for (let attempt = 0; attempt < SAVE_RETRIES; attempt++) {
      await this.git.fetch(['origin', '--prune']).catch(() => undefined);
      await this.suppressed(() => this.mergeDown()); // 타 참여자 저장분을 squash 전에 흡수(union)

      const tree = (await this.git.raw(['rev-parse', 'HEAD^{tree}'])).trim();
      const mainTree = (await this.refExists('refs/remotes/origin/main'))
        ? (await this.git.raw(['rev-parse', 'origin/main^{tree}'])).trim()
        : null;
      if (tree === mainTree) {
        await this.suppressed(() => this.finishToMain(null)); // 변경 없음 — wip 만 정리하고 main 으로
        return 'nochange';
      }

      const parent = mainTree ? ['-p', 'origin/main'] : [];
      const msg = `저장: ${this.displayName} ${nowIso()}`;
      const commit = (await this.git.raw(['commit-tree', tree, ...parent, '-m', msg])).trim();

      try {
        await this.git.raw(['push', 'origin', `${commit}:refs/heads/main`]);
      } catch (e) {
        if (attempt === SAVE_RETRIES - 1) throw e;
        await sleep(100 + Math.floor(Math.random() * 400)); // jitter 후 fetch 부터 재시도
        continue;
      }

      await this.suppressed(() => this.finishToMain(commit));
      return 'saved';
    }
    return 'nochange';
  }

  /** wip 종료: main 을 target(또는 origin/main)으로 두고 HEAD=main(워킹트리 미변경), 현 wip 삭제. */
  private async finishToMain(commit: string | null): Promise<void> {
    const wip = this.currentWip;
    const wasPushed = this.wipPushed;
    const target = commit ?? (await this.git.raw(['rev-parse', 'origin/main'])).trim();
    await this.git.raw(['branch', '-f', 'main', target]);
    await this.git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await this.git.raw(['reset', '--mixed']); // tree 동일 → 파일·mtime 무변경
    this.currentWip = null;
    this.wipPushed = false;
    if (wip) {
      await this.git.raw(['branch', '-D', wip]).catch(() => undefined);
      // 원격에 push 된 적 있을 때만 delete 시도 — 빠른 편집→저장(push 전 종료)에서 헛된 에러 로그 방지.
      if (wasPushed) {
        await this.git.raw(['push', 'origin', '--delete', wip]).catch((e) => this.log(`원격 wip 삭제 실패: ${redact(e)}`));
      }
    }
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
