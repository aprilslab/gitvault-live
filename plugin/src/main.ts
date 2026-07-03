import { Plugin, MarkdownView, FileSystemAdapter } from 'obsidian';
import {
  OgsSettings,
  DEFAULT_SETTINGS,
  GitSyncSettingTab,
  generateDeviceId,
  buildAuthedRemote,
} from './settings';
import { GitManager } from './git/GitManager';
import { AutoSync } from './sync/AutoSync';
import { StatusBar } from './ui/StatusBar';

const COMMIT_DEBOUNCE_MS = 3_000;

export default class GitSyncPlugin extends Plugin {
  settings!: OgsSettings;
  private git?: GitManager;
  private autoSync?: AutoSync;
  private statusBar?: StatusBar;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.addSettingTab(new GitSyncSettingTab(this.app, this));

    this.addRibbonIcon('git-branch', 'Git Sync: 지금 동기화', () => void this.applySettings());
    this.addCommand({
      id: 'ogs-sync-now',
      name: '지금 동기화 / 다시 연결',
      callback: () => void this.applySettings(),
    });

    // 시작 커밋 폭주 방지: 레이아웃 준비 후에 감시 시작.
    this.app.workspace.onLayoutReady(() => void this.applySettings());
  }

  onunload(): void {
    this.autoSync?.stop();
  }

  /** vault 워킹트리 절대경로 (데스크톱 전용 — 아니면 null). */
  getBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  /** 설정으로 GitManager/AutoSync 를 (재)구성하고 repo 를 보장한다. 설정 변경·리본·시작 시 호출. */
  async applySettings(): Promise<void> {
    this.autoSync?.stop();

    const base = this.getBasePath();
    if (!base) {
      this.statusBar?.set('error', '데스크톱 전용');
      return;
    }
    const authedRemote = buildAuthedRemote(this.settings);
    if (!authedRemote) {
      this.statusBar?.set('off');
      return;
    }

    const flushEditors = async (): Promise<void> => {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView) await view.save();
      }
    };

    this.git = new GitManager({
      basePath: base,
      authedRemote,
      deviceId: this.settings.deviceId,
      flushEditors,
      log: (m) => console.error('[obsidian-git-sync]', m),
    });

    this.statusBar?.set('syncing');
    try {
      await this.git.ensureRepo();
      this.statusBar?.set('synced');
    } catch (e) {
      this.statusBar?.set('error', e instanceof Error ? e.message.split('\n')[0] : String(e));
      return;
    }

    this.autoSync = new AutoSync({
      app: this.app,
      git: this.git,
      debounceMs: COMMIT_DEBOUNCE_MS,
      syncSeconds: this.settings.autoSyncSeconds,
      onState: (s, d) => this.statusBar?.set(s, d),
      // onSynced: Phase C 에서 DiffPanel/데코레이션 갱신 연결
    });
    this.autoSync.start();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.deviceId) {
      this.settings.deviceId = generateDeviceId();
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
