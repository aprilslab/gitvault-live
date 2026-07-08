import { ItemView, WorkspaceLeaf, TFile, Modal, Notice, App } from 'obsidian';
import type { GitManager, FileCommit } from '../git/GitManager';

export const VIEW_TYPE_OGS_HISTORY = 'ogs-history-panel';

/**
 * 사이드 패널: 활성 파일의 git 커밋 이력(저장본). 커밋 클릭 → 그 시점 문서 미리보기 모달.
 * 활성 파일이 바뀌거나 sync 될 때 갱신.
 */
export class HistoryPanel extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly getGit: () => GitManager | undefined,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OGS_HISTORY;
  }
  getDisplayText(): string {
    return '파일 이력';
  }
  getIcon(): string {
    return 'history';
  }

  async onOpen(): Promise<void> {
    // 활성 파일 전환 시 자동 갱신.
    this.registerEvent(this.app.workspace.on('file-open', () => void this.refresh()));
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const git = this.getGit();
    const file = this.app.workspace.getActiveFile();

    let commits: FileCommit[] = [];
    if (git && file) {
      try {
        commits = await git.fileHistory(file.path);
      } catch {
        /* 오프라인/일시 오류 — 빈 목록 */
      }
    }

    // 데이터 확보 후 한 번에 교체 (겹친 refresh 의 중복 렌더 방지).
    const root = this.contentEl;
    root.empty();
    root.addClass('ogs-history-panel');

    if (!git) {
      root.createEl('div', { text: '미연결 — 설정에서 저장소를 연결하세요.', cls: 'ogs-history-empty' });
      return;
    }
    if (!file) {
      root.createEl('div', { text: '노트를 열면 그 파일의 이력이 표시됩니다.', cls: 'ogs-history-empty' });
      return;
    }

    root.createEl('div', { text: file.path, cls: 'ogs-history-file' });
    if (commits.length === 0) {
      root.createEl('div', { text: '아직 저장된 이력이 없습니다.', cls: 'ogs-history-empty' });
      return;
    }

    for (const c of commits) {
      const row = root.createEl('div', { cls: 'ogs-history-row' });
      row.createEl('div', { text: c.subject || '(제목 없음)', cls: 'ogs-history-subject' });
      row.createEl('div', {
        text: `${c.author} · ${c.date} · ${c.shortHash}`,
        cls: 'ogs-history-meta',
      });
      row.addEventListener('click', () => void this.openCommit(git, file, c));
    }
  }

  private async openCommit(git: GitManager, file: TFile, c: FileCommit): Promise<void> {
    const content = await git.fileAtCommit(c.hash, file.path);
    if (content === null) {
      new Notice('이 커밋에는 해당 파일이 없습니다.');
      return;
    }
    new HistoryVersionModal(this.app, file, c, content).open();
  }
}

/** 커밋 시점 문서 미리보기 + 이 버전으로 되돌리기. */
class HistoryVersionModal extends Modal {
  constructor(
    app: App,
    private readonly file: TFile,
    private readonly commit: FileCommit,
    private readonly content: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(`${this.file.basename} · ${this.commit.date}`);

    contentEl.createEl('div', {
      text: `${this.commit.author} · ${this.commit.shortHash} · ${this.commit.subject}`,
      cls: 'ogs-history-modal-meta',
    });

    const pre = contentEl.createEl('pre', { cls: 'ogs-history-modal-body' });
    pre.createEl('code', { text: this.content });

    const bar = contentEl.createEl('div', { cls: 'ogs-history-modal-actions' });
    const restore = bar.createEl('button', { text: '이 버전으로 되돌리기' });
    restore.addEventListener('click', () => void this.restore());
    const close = bar.createEl('button', { text: '닫기' });
    close.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async restore(): Promise<void> {
    await this.app.vault.modify(this.file, this.content);
    new Notice(`${this.file.basename} 을(를) ${this.commit.date} 버전으로 되돌렸습니다. (저장하면 공식본에 반영)`);
    this.close();
  }
}
