import { Plugin, MarkdownView, FileSystemAdapter, TFile, Notice, Platform } from 'obsidian';
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
import { saveKeymap } from './editor/saveKeymap';
import { parseUnifiedHunks } from './editor/diffHunks';

const COMMIT_DEBOUNCE_MS = 3_000;

export default class GitSyncPlugin extends Plugin {
  settings!: OgsSettings;
  private git?: GitManager;
  private autoSync?: AutoSync;
  private statusBar?: StatusBar;
  private saveBadge?: HTMLElement;
  private saveNotice?: Notice;
  private publishing = false;
  private applyChain: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.addSettingTab(new GitSyncSettingTab(this.app, this));

    // 협업 인라인 데코레이션 + Cmd/Ctrl+S 저장 keymap (CM6, Source/라이브프리뷰).
    this.registerEditorExtension([collabDecorations(), saveKeymap(() => void this.publishNow())]);

    // 저장 안 된 변경이 있을 때 우측하단에 뜨는 클릭형 저장 버튼(리본 대체 + 미저장 표시).
    this.saveBadge = document.body.createDiv({ cls: 'ogs-save-badge' });
    this.saveBadge.hide();
    this.saveBadge.addEventListener('click', () => void this.publishNow());
    this.register(() => this.saveBadge?.remove());

    // 동시 편집 현황 패널.
    this.registerView(
      VIEW_TYPE_OGS_DIFF,
      (leaf) => new DiffPanel(leaf, () => this.git, (path) => this.openPath(path)),
    );

    this.addRibbonIcon('git-branch', 'Git Sync: 지금 동기화', () => void this.applySettings());
    this.addRibbonIcon('git-compare', 'Git Sync: 동시 편집 현황', () => void this.activateDiffPanel());
    this.addRibbonIcon('save', 'Git Sync: 저장(공식본에 반영)', () => void this.publishNow());
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
    this.addCommand({
      id: 'ogs-save',
      name: '저장 — 공식본에 반영',
      callback: () => void this.publishNow(),
    });
    // Cmd/Ctrl+S 는 위 registerEditorExtension 의 saveKeymap(Prec.highest)이 처리한다.

    // 활성 노트 전환 시 데코레이션 재계산. active-leaf-change 는 같은 탭 내 파일 전환(link/뒤로가기)엔
    // 안 뜨므로 file-open 도 함께 등록 — 안 그러면 이전 파일 데코가 새 문서에 남는다.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => void this.refreshActiveDecorations()));
    this.registerEvent(this.app.workspace.on('file-open', () => void this.refreshActiveDecorations()));

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

  /**
   * 설정으로 GitManager/AutoSync 를 (재)구성하고 repo 를 보장한다. 설정 변경·리본·시작 시 호출.
   * 동시/중첩 호출은 직렬화한다 — 두 GitManager 가 같은 `.git/index.lock` 에서 충돌하는 것 방지.
   */
  applySettings(): Promise<void> {
    this.applyChain = this.applyChain.catch(() => undefined).then(() => this.applySettingsLocked());
    return this.applyChain;
  }

  private async applySettingsLocked(): Promise<void> {
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

  /** 패널 + 활성 에디터 데코레이션 + "저장 대기 N" 상태바를 함께 갱신 (sync/커밋/저장 시). */
  private async refreshCollab(): Promise<void> {
    this.refreshPanels();
    await this.refreshActiveDecorations();
    await this.updatePublishStatus();
  }

  /** main 대비 미저장(outgoing) 파일 수를 상태바 + 플로팅 저장 버튼에 반영. */
  private async updatePublishStatus(): Promise<void> {
    if (!this.git) return;
    try {
      const outgoing = await this.git.outgoingFiles();
      this.statusBar?.setOutgoing(outgoing.length);
      this.updateSaveBadge(outgoing.length);
    } catch {
      /* 오프라인/일시 오류 — 상태 유지 */
    }
  }

  private updateSaveBadge(count: number): void {
    const badge = this.saveBadge;
    if (!badge) return;
    if (count > 0) {
      const key = Platform.isMacOS ? '⌘⇧S' : 'Ctrl+Shift+S';
      badge.setText(`● ${count}개 저장 안 됨 — 저장 (${key})`);
      badge.show();
    } else {
      badge.hide();
    }
  }

  private refreshPanels(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OGS_DIFF)) {
      const view = leaf.view;
      if (view instanceof DiffPanel) void view.refresh();
    }
  }

  /** 활성 markdown 노트의 origin/main 대비 hunk 를 계산해 CM6 데코레이션으로 반영(설정 켜졌을 때만). */
  private async refreshActiveDecorations(): Promise<void> {
    if (!this.git) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return;
    const cm = editorViewOf(view);
    if (!cm) return; // 리딩 모드 등 — 무시
    if (!this.settings.showInlineChanges) {
      pushHunks(cm, []); // 꺼졌으면 남은 데코 제거
      return;
    }
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

  /** 확인 모달 없이 바로 발행(squash-to-main). 결과는 단일 토스트(쌓이지 않게 이전 것 교체). */
  private async publishNow(): Promise<void> {
    if (!this.git) {
      this.toast('아직 연결되지 않았습니다 — 설정에서 저장소를 연결하세요.');
      return;
    }
    if (this.publishing) return; // 중복 실행 방지
    this.publishing = true;
    try {
      const files = await this.git.outgoingFiles();
      if (files.length === 0) {
        this.toast('저장할 변경이 없습니다.');
        return;
      }
      this.toast('저장 중…');
      const result = await this.git.squashMergeToMain();
      if (result === 'saved') {
        const shown = files.slice(0, 8).map((f) => `${statusMark(f.status)} ${f.path}`);
        const more = files.length - shown.length;
        const body = shown.join('\n') + (more > 0 ? `\n… 외 ${more}개` : '');
        this.toast(`✓ 저장됨 (${files.length}개)\n${body}`);
      } else {
        this.toast('저장할 변경이 없습니다.');
      }
      await this.refreshCollab();
    } catch (e) {
      this.toast(`저장 실패: ${firstLine(e)}`);
    } finally {
      this.publishing = false;
    }
  }

  /** 단일 토스트 — 이전 것을 숨기고 새로 띄워 쌓이지 않게 한다. 여러 줄(\n)은 줄바꿈 렌더. */
  private toast(text: string): void {
    this.saveNotice?.hide();
    const frag = document.createDocumentFragment();
    text.split('\n').forEach((line, i) => {
      if (i > 0) frag.appendChild(document.createElement('br'));
      frag.appendChild(document.createTextNode(line));
    });
    this.saveNotice = new Notice(frag, 6000);
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

function firstLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0].slice(0, 120);
}

function statusMark(status: string): string {
  const c = status[0];
  if (c === 'A') return '＋';
  if (c === 'D') return '－';
  if (c === 'R') return '↦';
  return '·';
}
