import { App, EventRef, TAbstractFile } from 'obsidian';
import { GitManager } from '../git/GitManager';
import type { SyncState } from '../ui/StatusBar';

const IDLE_MERGE_MS = 5_000; // 이 시간 이상 타이핑이 없어야 워킹트리 merge(에디터 리로드) 수행

export interface AutoSyncOptions {
  app: App;
  git: GitManager;
  debounceMs: number;
  syncSeconds: number;
  onState: (state: SyncState, detail?: string) => void;
  /** 60s 사이클(fetch)마다 호출 — DiffPanel/데코레이션 갱신(Phase C). */
  onSynced?: () => void;
}

/**
 * vault 이벤트 → 디바운스 wip 커밋·푸시 + 주기 fetch/sync-down.
 * - onLayoutReady 이후 start() (시작 커밋 폭주 방지).
 * - git 자기 쓰기(eventsSuppressed)는 드롭 → 이벤트 피드백 루프 차단.
 * - 워킹트리 merge 는 타이핑 idle 에만(열린 에디터 비교란). fetch·패널 갱신은 매 사이클.
 */
export class AutoSync {
  private readonly refs: EventRef[] = [];
  private commitTimer = 0;
  private syncTimer = 0;
  private lastKeystroke = 0;
  private stopped = false;

  constructor(private readonly opts: AutoSyncOptions) {}

  start(): void {
    this.stopped = false;
    const vault = this.opts.app.vault;
    const onChange = (f: TAbstractFile) => this.onVaultChange(f);
    this.refs.push(vault.on('modify', onChange));
    this.refs.push(vault.on('create', onChange));
    this.refs.push(vault.on('delete', onChange));
    this.refs.push(vault.on('rename', onChange));
    this.scheduleSync();
  }

  stop(): void {
    this.stopped = true;
    for (const r of this.refs) this.opts.app.vault.offref(r);
    this.refs.length = 0;
    if (this.commitTimer) window.clearTimeout(this.commitTimer);
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
  }

  private onVaultChange(_f: TAbstractFile): void {
    if (this.opts.git.eventsSuppressed) return; // git 이 방금 쓴 파일 — 되커밋 방지
    this.lastKeystroke = Date.now();
    this.opts.onState('pending');
    if (this.commitTimer) window.clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => void this.commit(), this.opts.debounceMs);
  }

  private async commit(): Promise<void> {
    this.opts.onState('syncing');
    try {
      await this.opts.git.commitAndPushWip();
      this.opts.onState('synced');
    } catch (e) {
      this.opts.onState('error', short(e));
    }
  }

  private scheduleSync(): void {
    this.syncTimer = window.setTimeout(() => {
      void this.runSync().finally(() => {
        if (!this.stopped) this.scheduleSync();
      });
    }, this.opts.syncSeconds * 1_000);
  }

  private async runSync(): Promise<void> {
    const idle = Date.now() - this.lastKeystroke > IDLE_MERGE_MS;
    try {
      await this.opts.git.syncDown(idle); // idle 이면 merge, 아니면 fetch 만
      this.opts.onSynced?.();
      this.opts.onState('synced');
    } catch (e) {
      this.opts.onState('error', short(e));
    }
  }
}

function short(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0].slice(0, 80);
}
