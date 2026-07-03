import { simpleGit, SimpleGit } from 'simple-git';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PromiseQueue } from './queue';
import { defaultDeviceId, type DaemonConfig } from './config';

const IDENTITY_EMAIL_DOMAIN = 'obsidian-git-sync.local';
const DEVICE_ID_FILE = 'ogs-device-id'; // .git/ 하위 — 동기화되지 않고 기기 고정
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

  /** 주기 sync-down: origin/main 을 로컬 main 으로 병합(직렬화). */
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
    await this.ensureMainBranch();
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
      // 원격이 비었으면 현재 워킹트리 + seed 파일로 첫 main.
      await this.git.raw(['checkout', '-B', 'main']);
      this.seedRepoFiles();
    }
  }

  /** 빈 원격 seed: .gitattributes(union) + .gitignore 를 워킹트리에 둔다(첫 커밋에 흡수됨). 기존 파일은 존중. */
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
  return (err: unknown) => console.error(`[obsidian-git-sync] ${label} 실패:`, err);
}
