import { Plugin, MarkdownView, FileSystemAdapter, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
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
import { DiffPanel, VIEW_TYPE_OGS_DIFF } from './ui/DiffPanel';
import { collabDecorations, pushHunks } from './editor/CollabDecorations';
import { parseUnifiedHunks } from './editor/diffHunks';

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

    // 협업 인라인 데코레이션 (CM6, Source/라이브프리뷰).
    this.registerEditorExtension(collabDecorations());

    // 동시 편집 현황 패널.
    this.registerView(
      VIEW_TYPE_OGS_DIFF,
      (leaf) => new DiffPanel(leaf, () => this.git, (path) => this.openPath(path)),
    );

    this.addRibbonIcon('git-branch', 'Git Sync: 지금 동기화', () => void this.applySettings());
    this.addRibbonIcon('git-compare', 'Git Sync: 동시 편집 현황', () => void this.activateDiffPanel());
    this.addCommand({
      id: 'ogs-sync-now',
      name: '지금 동기화 / 다시 연결',
      callback: () => void this.applySettings(),
    });
    this.addCommand({
      id: 'ogs-open-diff-panel',
      name: '동시 편집 현황 패널 열기',
      callback: () => void this.activateDiffPanel(),
    });

    // 활성 노트 전환 시 데코레이션 재계산.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => void this.refreshActiveDecorations()));

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
      onSynced: () => void this.refreshCollab(),
    });
    this.autoSync.start();
    void this.refreshCollab();
  }

  /** 패널 + 활성 에디터 데코레이션을 함께 갱신 (60s sync 사이클마다). */
  private async refreshCollab(): Promise<void> {
    this.refreshPanels();
    await this.refreshActiveDecorations();
  }

  private refreshPanels(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OGS_DIFF)) {
      const view = leaf.view;
      if (view instanceof DiffPanel) void view.refresh();
    }
  }

  /** 활성 markdown 노트의 origin/main 대비 hunk 를 계산해 CM6 데코레이션으로 반영. */
  private async refreshActiveDecorations(): Promise<void> {
    if (!this.git) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return;
    const cm = editorViewOf(view);
    if (!cm) return; // 리딩 모드 등 — 무시
    try {
      const diff = await this.git.fileDiffVsMain(view.file.path);
      pushHunks(cm, parseUnifiedHunks(diff));
    } catch {
      /* 일시 오류 — 데코레이션 갱신만 건너뜀 */
    }
  }

  private async activateDiffPanel(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_OGS_DIFF)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_OGS_DIFF, active: true });
    workspace.revealLeaf(leaf);
  }

  private openPath(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
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

/** Obsidian 의 MarkdownView 에서 내부 CM6 EditorView 를 꺼낸다(공식 타입 미노출 → 캐스팅). */
function editorViewOf(view: MarkdownView): EditorView | undefined {
  return (view.editor as unknown as { cm?: EditorView }).cm;
}
