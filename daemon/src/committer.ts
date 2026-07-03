import { simpleGit, SimpleGit } from 'simple-git';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PromiseQueue } from './queue';
import { defaultDeviceId, type DaemonConfig } from './config';

const IDENTITY_EMAIL_DOMAIN = 'obsidian-git-sync.local';
const DEVICE_ID_FILE = 'ogs-device-id'; // .git/ 하위 — 동기화되지 않고 기기 고정
const SYNC_INTERVAL_MS = 60_000;
const GIT_BLOCK_TIMEOUT_MS = 20_000; // git op 이 이 시간 동안 무출력이면 중단(hung fetch 방지)

/**
 * vault git repo 를 다루는 데몬 코어.
 * - 변경 디바운스 → wip/<device> 커밋·푸시
 * - idle → main 자동 저장(squash, plumbing)
 * - 주기 sync-down (origin/main → wip 병합)
 * 모든 git op 는 PromiseQueue 로 직렬화된다.
 */
export class Committer {
  private readonly git: SimpleGit;
  private readonly queue = new PromiseQueue();

  private deviceId = '';
  private wipRef = '';

  private commitTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly cfg: DaemonConfig) {
    this.git = simpleGit(cfg.vaultPath, { timeout: { block: GIT_BLOCK_TIMEOUT_MS } });
  }

  /** repo 보장 → 초기 sync-down(offline 허용) → 타이머 기동. */
  async start(): Promise<void> {
    await this.ensureRepo();
    await this.syncDown().catch(logErr('initial-sync')); // offline 이어도 감시는 계속되게
    this.scheduleSync();
    this.resetIdleTimer();
  }

  /** 종료/테스트용: 모든 타이머 해제. */
  stop(): void {
    this.stopped = true;
    for (const t of [this.commitTimer, this.idleTimer, this.syncTimer]) if (t) clearTimeout(t);
  }

  /** watcher 가 호출. 디바운스 후 커밋·푸시. 매 변경마다 idle 타이머 갱신. */
  onChange(): void {
    this.resetIdleTimer();
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => void this.commitAndPush().catch(logErr('commit-push')), this.cfg.debounceMs);
  }

  /** wip/<device> 로 커밋·푸시 (직렬화). 테스트에서 직접 호출 가능. */
  commitAndPush(): Promise<void> {
    return this.queue.add(async () => {
      await this.flushCommit();
      await this.pushWip();
    });
  }

  /** 공용 저장 시퀀스: sync-down 후 merged tree 를 origin/main 위 1커밋으로 push (checkout 없음). */
  save(): Promise<'saved' | 'nochange'> {
    return this.queue.add(() => this.saveLocked());
  }

  /** 주기 sync-down (직렬화). */
  syncDown(): Promise<void> {
    return this.queue.add(async () => {
      await this.flushCommit();
      await this.git.fetch(['origin', '--prune']);
      await this.mergeDown();
    });
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

    await this.git.addConfig('user.name', this.deviceId);
    await this.git.addConfig('user.email', `${this.deviceId}@${IDENTITY_EMAIL_DOMAIN}`);
    // 비-ASCII(한글) 파일명이 status 에서 C-quote 되지 않도록 — 파싱/pathspec 매칭 정확성 필수.
    await this.git.addConfig('core.quotePath', 'false');

    const remotes = await this.git.getRemotes(true).catch(() => []);
    if (!remotes.find((r) => r.name === 'origin')) {
      await this.git.raw(['remote', 'add', 'origin', this.cfg.remote]);
    }
    await this.git.fetch(['origin', '--prune']).catch(() => undefined);
    await this.ensureWipBranch();
  }

  /** DEVICE_ID env > .git/ogs-device-id 영속값 > 신규 생성(영속화). 재시작 시 동일 wip 유지. */
  private resolveDeviceId(): void {
    if (this.cfg.deviceId) {
      this.deviceId = this.cfg.deviceId;
    } else {
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
    this.wipRef = `wip/${this.deviceId}`;
  }

  private async ensureWipBranch(): Promise<void> {
    const local = await this.git.branchLocal().catch(() => ({ all: [] as string[] }));
    if (local.all.includes(this.wipRef)) {
      await this.git.raw(['checkout', this.wipRef]);
      return;
    }
    if (await this.refExists('refs/remotes/origin/main')) {
      // origin/main 위에 wip 을 만들되 워킹트리를 덮지 않는다.
      // (checkout -B origin/main 은 untracked 로컬 파일과 충돌 시 abort → 기존 vault 온보딩 크래시.)
      // 로컬 파일은 index 에 흡수하고, 원격 전용 파일만 워킹트리로 실체화한다.
      await this.git.raw(['branch', '-f', this.wipRef, 'origin/main']);
      await this.git.raw(['symbolic-ref', 'HEAD', `refs/heads/${this.wipRef}`]);
      await this.git.raw(['reset', '--mixed']); // index=origin/main, 워킹트리 보존
      await this.git.raw(['add', '--ignore-removal', '--', '.']); // 로컬 추가/수정 stage(원격전용 삭제 안 함)
      const status = await this.git.raw(['status', '--porcelain']);
      if (status.trim()) await this.git.commit(`adopt: ${nowIso()}`);
      await this.git.raw(['checkout-index', '-a']); // index→워킹트리 실체화(기존 파일은 미덮어씀)
    } else {
      // 원격이 비었으면 현재 워킹트리로 첫 wip.
      await this.git.raw(['checkout', '-B', this.wipRef]);
    }
  }

  /** add -A 후 변경 없으면 skip(=이벤트 루프 구조적 종결자), 있으면 커밋. */
  private async flushCommit(): Promise<void> {
    await this.git.add(['-A']);
    const status = await this.git.raw(['status', '--porcelain']);
    if (!status.trim()) return;
    await this.git.commit(`${this.deviceId}: ${nowIso()}`);
  }

  private async pushWip(): Promise<void> {
    const spec = `HEAD:refs/heads/${this.wipRef}`;
    try {
      // 평시(디바운스 커밋)엔 fast-forward.
      await this.git.raw(['push', 'origin', spec]);
    } catch {
      // 저장 후 reset --soft 한 wip 은 원격과 sibling(비-ff) — 이땐 force-with-lease 로 재정렬.
      // 단일 작성자 전제라 lease 가 어긋나면(타 작성자) 시끄럽게 실패하는 게 옳다.
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

  private async saveLocked(): Promise<'saved' | 'nochange'> {
    await this.flushCommit();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.git.fetch(['origin', '--prune']);
      await this.mergeDown();

      const tree = (await this.git.raw(['rev-parse', 'HEAD^{tree}'])).trim();
      const mainTree = await this.originMainTree();
      if (tree === mainTree) return 'nochange';

      const parent = (await this.refExists('refs/remotes/origin/main')) ? ['-p', 'origin/main'] : [];
      const msg = `저장: ${this.deviceId} ${nowIso()}`;
      const commit = (await this.git.raw(['commit-tree', tree, ...parent, '-m', msg])).trim();

      try {
        await this.git.raw(['push', 'origin', `${commit}:refs/heads/main`]);
      } catch (e) {
        if (attempt === 2) throw e;
        await sleep(100 + Math.floor(Math.random() * 400)); // jitter 후 fetch 부터 재시도
        continue;
      }

      await this.git.raw(['reset', '--soft', commit]); // wip 포인터만 이동, 워킹트리·mtime 무변경
      await this.pushWip();
      return 'saved';
    }
    return 'nochange';
  }

  private async originMainTree(): Promise<string | null> {
    if (!(await this.refExists('refs/remotes/origin/main'))) return null;
    return (await this.git.raw(['rev-parse', 'origin/main^{tree}'])).trim();
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      await this.git.raw(['rev-parse', '--verify', '--quiet', ref]);
      return true;
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

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.save().catch(logErr('idle-save')), this.cfg.autosaveIdleMs);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function logErr(label: string) {
  return (err: unknown) => console.error(`[obsidian-git-sync] ${label} 실패:`, err);
}
