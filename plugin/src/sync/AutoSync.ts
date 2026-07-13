import { App, EventRef, TAbstractFile } from 'obsidian';
import { GitManager, isNetworkError } from '../git/GitManager';
import type { SyncState } from '../ui/StatusBar';

const IDLE_MERGE_MS = 5_000; // 이 시간 이상 타이핑이 없어야 워킹트리 merge(에디터 리로드) 수행

export interface AutoSyncOptions {
  app: App;
  git: GitManager;
  debounceMs: number;
  syncSeconds: number;
  onState: (state: SyncState, detail?: string) => void;
  /** 60s 사이클(fetch)마다 호출 — 이력 패널/데코레이션 갱신. */
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
  private readonly wsRefs: EventRef[] = []; // workspace 이벤트 — offref 대상 emitter 가 vault 와 다름
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
    // vault modify 는 Obsidian autosave(~2s) 뒤에야 발화 — idle 판정용 키입력 추적은
    // editor-change(실제 타이핑 즉시)로 별도 갱신해야 merge 연기 판정이 정확하다.
    this.wsRefs.push(
      this.opts.app.workspace.on('editor-change', () => {
        this.lastKeystroke = Date.now();
      }),
    );
    this.scheduleSync();
  }

  stop(): void {
    this.stopped = true;
    for (const r of this.refs) this.opts.app.vault.offref(r);
    this.refs.length = 0;
    for (const r of this.wsRefs) this.opts.app.workspace.offref(r);
    this.wsRefs.length = 0;
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
      this.opts.onSynced?.(); // 커밋 후 패널·데코·"저장 대기 N" 갱신
    } catch (e) {
      this.reportFailure(e);
    }
  }

  private scheduleSync(): void {
    this.syncTimer = window.setTimeout(() => {
      void this.runSync().finally(() => {
        if (!this.stopped) this.scheduleSync();
      });
    }, this.opts.syncSeconds * 1_000);
  }

  /** merge 직전(느린 fetch 이후)에도 GitManager 가 재평가할 수 있도록 콜백으로 전달. */
  private readonly isStillIdle = (): boolean => Date.now() - this.lastKeystroke > IDLE_MERGE_MS;

  private async runSync(): Promise<void> {
    try {
      await this.opts.git.syncDown(this.isStillIdle(), this.isStillIdle); // idle 이면 merge, 아니면 fetch 만
      this.opts.onSynced?.();
      this.opts.onState('synced');
    } catch (e) {
      this.reportFailure(e);
    }
  }

  /** 네트워크/오프라인은 빨간 '오류' 대신 '오프라인'(대기)으로 — 연결되면 자동 재개된다. 그 외는 실제 오류. */
  private reportFailure(e: unknown): void {
    if (isNetworkError(e)) this.opts.onState('pending', '오프라인');
    else this.opts.onState('error', short(e));
  }
}

function short(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0].slice(0, 80);
}
