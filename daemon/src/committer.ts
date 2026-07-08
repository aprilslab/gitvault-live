import { simpleGit, SimpleGit } from 'simple-git';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PromiseQueue } from './queue';
import { defaultDeviceId, defaultDaemonDisplayName, type DaemonConfig } from './config';

const IDENTITY_EMAIL_DOMAIN = 'gitvault-live.local';
const DEVICE_ID_FILE = 'ogs-device-id'; // .git/ 하위 — 동기화되지 않고 기기 고정
// 플러그인(Obsidian) 생존 신호 파일. 플러그인 Heartbeat 가 .git/ 에 epoch ms 를 주기 기록한다.
// 신선하면 Obsidian 이 vault 를 소유 중 → daemon 은 commit/merge 를 후퇴한다(양쪽이 같은 .git·워킹트리
// 를 공유하므로 동시 조작 금지). 낡음/부재 = Obsidian 종료 → daemon 이 파일 변경을 main 에 반영.
export const HEARTBEAT_FILE = 'ogs-plugin-alive'; // 플러그인 Heartbeat 와 공유하는 파일명(계약)
const HEARTBEAT_STALE_MS = 30_000; // 플러그인 갱신 주기(10s)의 3배 — 일시 지연에 관대
const SYNC_INTERVAL_MS = 60_000;
const GIT_BLOCK_TIMEOUT_MS = 20_000; // git op 이 이 시간 동안 무출력이면 중단(hung fetch 방지)
const PUSH_RETRIES = 3;

/**
 * 에이전트(헤드리스) vault git 클라이언트.
 * - 변경 디바운스 → 로컬 main 커밋 → origin/main union 병합 → push main (경합 시 재시도)
 * - 주기 sync-down (origin/main → 로컬 main 병합; 유휴 시 타 참여자 변경 수신)
 *
 * SoT = 표준 호스팅 git repo (HTTPS 토큰). 특수 서버·wip 브랜치·idle-squash 없음 —
 * 에이전트는 "저장 버튼" 주체가 없으므로 매 배치를 main 에 직접 연속 전진시킨다.
 * 헤드리스라 열린 에디터가 없어 로컬 main 체크아웃/merge 가 안전하다.
 * 모든 git op 는 PromiseQueue 로 직렬화된다.
 */
export class Committer {
  private readonly git: SimpleGit;
  private readonly queue = new PromiseQueue();

  private deviceId = '';
  /**
   * git author.name — DISPLAY_NAME env 명시값 > defaultDaemonDisplayName(git user.name/homedir/deviceId 폴백) + '-bot' 접미어.
   * 이메일은 여전히 deviceId 기반(안정적 identity) — displayName 은 오직 표시용.
   */
  private displayName = '';

  private commitTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly cfg: DaemonConfig) {
    this.git = simpleGit(cfg.vaultPath, { timeout: { block: GIT_BLOCK_TIMEOUT_MS } });
  }

  /** repo 보장 → 초기 push(adopt/seed 를 main 에 반영, offline 허용) → 주기 sync 기동. */
  async start(): Promise<void> {
    await this.ensureRepo();
    await this.commitAndPush().catch(logErr('initial-push')); // offline 이어도 감시는 계속되게
    this.scheduleSync();
  }

  /** 종료/테스트용: 모든 타이머 해제. */
  stop(): void {
    this.stopped = true;
    for (const t of [this.commitTimer, this.syncTimer]) if (t) clearTimeout(t);
  }

  /** watcher 가 호출. 디바운스 후 커밋·푸시. */
  onChange(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => void this.commitAndPush().catch(logErr('commit-push')), this.cfg.debounceMs);
  }

  /** 로컬 main 커밋 → origin/main 병합 → push main. 경합 시 fetch 부터 재시도(직렬화). */
  commitAndPush(): Promise<'pushed' | 'nochange'> {
    return this.queue.add(() => this.pushMainLocked());
  }

  /** 주기 sync-down: origin/main 을 로컬 main 으로 병합(직렬화). 플러그인 활성 시 후퇴. */
  syncDown(): Promise<void> {
    return this.queue.add(async () => {
      if (this.pluginActive()) return; // Obsidian 이 워킹트리 소유 중 — merge 로 건드리지 않음
      await this.flushCommit();
      await this.git.fetch(['origin', '--prune']);
      await this.mergeDown();
    });
  }

  /**
   * 플러그인(Obsidian)이 이 vault 를 소유 중인가 — `.git/ogs-plugin-alive` 가 신선하면 true.
   * 신선하면 daemon 은 commit/merge 를 전면 후퇴한다(플러그인이 wip/저장 흐름 담당, 공유 .git 충돌 방지).
   */
  private pluginActive(): boolean {
    try {
      const raw = readFileSync(join(this.cfg.vaultPath, '.git', HEARTBEAT_FILE), 'utf8').trim();
      const ts = Number(raw);
      return Number.isFinite(ts) && Date.now() - ts < HEARTBEAT_STALE_MS;
    } catch {
      return false; // 파일 없음/읽기 실패 = Obsidian 미실행
    }
  }

  /** 현재 deviceId (테스트/로깅용). start() 이후 유효. */
  get device(): string {
    return this.deviceId;
  }

  // ── 내부 ──────────────────────────────────────────────────────────────

  private async ensureRepo(): Promise<void> {
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (!isRepo) await this.git.init();

    this.resolveDeviceId(); // .git 존재 후 (init 완료) 영속 id 확정
    // displayName: env 명시값 > git global user.name + '-bot' > homedir 이름 + '-bot' > deviceId + '-bot'
    this.displayName = this.cfg.displayName?.trim() || defaultDaemonDisplayName(this.deviceId);

    await this.git.addConfig('user.name', this.displayName);
    await this.git.addConfig('user.email', `${this.deviceId}@${IDENTITY_EMAIL_DOMAIN}`);
    // 비-ASCII(한글) 파일명이 status 에서 C-quote 되지 않도록 — 파싱/pathspec 매칭 정확성 필수.
    await this.git.addConfig('core.quotePath', 'false');

    const remotes = await this.git.getRemotes(true).catch(() => []);
    const hasOrigin = !!remotes.find((r) => r.name === 'origin');
    if (!hasOrigin) {
      // REMOTE 없고 기존 origin 도 없음 → 부트스트랩 불가. plugin 은 status='off' 로 대기하지만 daemon 은 헤드리스라 명확 에러로 종료.
      if (!this.cfg.remote) throw new Error('REMOTE 환경변수 또는 vault 에 기존 origin 이 필요합니다');
      await this.git.raw(['remote', 'add', 'origin', this.cfg.remote]);
    }
    // else: origin 존재 → 재사용(기기 자격증명·SSH·이미 박힌 토큰). REMOTE 로 덮어쓰지 않는다(설정 파기 방지).
    await this.git.fetch(['origin', '--prune']).catch(() => undefined);
    // 플러그인(Obsidian)이 활성이면 온보딩(체크아웃/adopt/seed = 워킹트리 조작)을 건너뛴다 —
    // 같은 .git·워킹트리를 공유하므로 플러그인이 이미 온보딩했고, daemon 이 손대면 충돌한다.
    // 플러그인이 종료되면 이후 pushMainLocked 의 ensureOnMainTakeover + flushCommit 이 인수한다.
    if (this.pluginActive()) return;
    await this.ensureMainBranch();
    // 모든 경로(adopt/기존 main/빈 원격 seed)에서 union 드라이버 보장 — 없으면 .md 충돌이
    // -X theirs(원격 승)로 떨어져 로컬 편집이 조용히 소실된다. wx 라 기존 파일은 존중.
    this.seedRepoFiles();
  }

  /** DEVICE_ID env > .git/ogs-device-id 영속값 > 신규 생성(영속화). 재시작 시 동일 identity 유지. */
  private resolveDeviceId(): void {
    if (this.cfg.deviceId) {
      this.deviceId = this.cfg.deviceId;
      return;
    }
    const idFile = join(this.cfg.vaultPath, '.git', DEVICE_ID_FILE);
    let id = '';
    try {
      id = readFileSync(idFile, 'utf8').trim();
    } catch {
      /* 없으면 생성 */
    }
    if (!id) {
      id = defaultDeviceId();
      try {
        writeFileSync(idFile, `${id}\n`);
      } catch (e) {
        logErr('device-id-persist')(e);
      }
    }
    this.deviceId = id;
  }

  /** 로컬 main 확보. 원격 main 있으면 워킹트리 파괴 없이 흡수(adopt), 없으면 seed. */
  private async ensureMainBranch(): Promise<void> {
    const local = await this.git.branchLocal().catch(() => ({ all: [] as string[] }));
    if (local.all.includes('main')) {
      await this.git.raw(['checkout', 'main']);
      return;
    }
    if (await this.refExists('refs/remotes/origin/main')) {
      // origin/main 위에 로컬 main 을 만들되 워킹트리를 덮지 않는다.
      // (checkout -B origin/main 은 untracked 로컬 파일과 충돌 시 abort → 기존 vault 온보딩 크래시.)
      // 로컬 파일은 index 에 흡수하고, 원격 전용 파일만 워킹트리로 실체화한다.
      await this.git.raw(['branch', '-f', 'main', 'origin/main']);
      await this.git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
      await this.git.raw(['reset', '--mixed']); // index=origin/main, 워킹트리 보존
      await this.git.raw(['add', '--ignore-removal', '--', '.']); // 로컬 추가/수정 stage(원격전용 삭제 안 함)
      const status = await this.git.raw(['status', '--porcelain']);
      if (status.trim()) await this.git.commit(`adopt: ${nowIso()}`);
      await this.git.raw(['checkout-index', '-a']); // index→워킹트리 실체화(기존 파일은 미덮어씀)
    } else {
      // 원격이 비었으면 현재 워킹트리로 첫 main (seed 파일은 ensureRepo 가 공통 생성).
      await this.git.raw(['checkout', '-B', 'main']);
    }
  }

  /** seed 파일 보장: .gitattributes(union) + .gitignore (다음 커밋에 흡수됨). 기존 파일은 존중(wx). */
  private seedRepoFiles(): void {
    const attrs = join(this.cfg.vaultPath, '.gitattributes');
    const ignore = join(this.cfg.vaultPath, '.gitignore');
    try {
      writeFileSync(attrs, '*.md merge=union\n* text=auto eol=lf\n', { flag: 'wx' });
    } catch {
      /* 이미 있으면 존중 */
    }
    try {
      writeFileSync(ignore, '.obsidian/\n.DS_Store\nThumbs.db\n', { flag: 'wx' });
    } catch {
      /* 존중 */
    }
  }

  /** add -A 후 변경 없으면 skip(=이벤트 루프 구조적 종결자), 있으면 커밋. */
  private async flushCommit(): Promise<void> {
    await this.git.add(['-A']);
    const status = await this.git.raw(['status', '--porcelain']);
    if (!status.trim()) return;
    await this.git.commit(`${this.deviceId}: ${nowIso()}`);
  }

  /** 로컬 main 을 origin/main 위로 병합 후 push. 경합(non-ff) 시 fetch 부터 재시도. */
  private async pushMainLocked(): Promise<'pushed' | 'nochange'> {
    if (this.pluginActive()) return 'nochange'; // Obsidian 활성 — 플러그인이 담당, daemon 후퇴
    await this.ensureOnMainTakeover(); // 플러그인이 HEAD 를 wip 에 남겼을 수 있음 → main 으로 복귀
    await this.flushCommit();
    for (let attempt = 0; attempt < PUSH_RETRIES; attempt++) {
      await this.git.fetch(['origin', '--prune']).catch(() => undefined);
      await this.mergeDown();

      const head = (await this.git.raw(['rev-parse', 'HEAD'])).trim();
      const originMain = (await this.refExists('refs/remotes/origin/main'))
        ? (await this.git.raw(['rev-parse', 'origin/main'])).trim()
        : null;
      if (head === originMain) return 'nochange'; // 로컬에 새 내용 없음 → 빈 push 방지

      try {
        await this.git.raw(['push', 'origin', 'HEAD:refs/heads/main']);
        return 'pushed';
      } catch (e) {
        if (attempt === PUSH_RETRIES - 1) throw e;
        await sleep(100 + Math.floor(Math.random() * 400)); // jitter 후 fetch 부터 재시도
      }
    }
    return 'nochange';
  }

  /**
   * 커밋 전 HEAD 를 main 으로 되돌린다. 플러그인은 편집 세션에서 HEAD 를 `wip/<device>/<ts>` 에
   * 남긴 채 종료할 수 있는데(공유 .git), daemon 인수 시 그 위에 커밋하면 안 되기 때문.
   * 워킹트리는 보존(symbolic-ref + reset --mixed) — 디스크의 변경분(AI가 쓴 것)이 이어지는
   * add -A 로 main 에 실린다. 이미 main 이면 no-op.
   */
  private async ensureOnMainTakeover(): Promise<void> {
    const head = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'main')).trim();
    if (head === 'main') return;
    if (!(await this.refExists('refs/heads/main'))) {
      await this.git.raw(['checkout', '-B', 'main']); // 방어적 — start()가 보통 보장
      return;
    }
    await this.git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await this.git.raw(['reset', '--mixed']); // index=main, 워킹트리 불변
  }

  /** origin/main 을 현재 브랜치로 병합. .md 는 union, 그 외 -X theirs. 잔여 충돌은 폴백. */
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
    // core.quotePath=false 로 설정되어 있으므로 path 는 원문 그대로 파싱된다.
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

  private async refExists(ref: string): Promise<boolean> {
    try {
      // simple-git 은 `--quiet` 로 exit 1 이어도 throw 하지 않고 빈 문자열을 resolve 한다 →
      // 존재 판정은 출력(sha) 유무로 해야 한다. (throw 케이스도 대비해 try/catch 유지.)
      const out = await this.git.raw(['rev-parse', '--verify', '--quiet', ref]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** 겹침 없는 주기 sync-down: 직전 실행이 끝난 뒤에야 다음을 예약한다(hung fetch backlog 방지). */
  private scheduleSync(): void {
    this.syncTimer = setTimeout(() => {
      void this.syncDown()
        .catch(logErr('sync-down'))
        .finally(() => {
          if (!this.stopped) this.scheduleSync();
        });
    }, SYNC_INTERVAL_MS);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function logErr(label: string) {
  return (err: unknown) => console.error(`[gitvault-live] ${label} 실패:`, err);
}
