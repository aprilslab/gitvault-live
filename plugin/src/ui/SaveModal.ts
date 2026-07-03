import { App, ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import type { GitManager } from '../git/GitManager';

/**
 * "저장" 모달: origin/main 대비 변경 파일 미리보기 → 확인 → squash-to-main.
 * git 개념(브랜치/squash)은 노출하지 않는다 — "공식본에 반영"으로만 표현.
 */
export class SaveModal extends Modal {
  constructor(
    app: App,
    private readonly git: GitManager,
    private readonly onSaved?: () => void,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '저장 — 공식본에 반영' });

    const listEl = contentEl.createEl('div', { cls: 'ogs-diff-panel' });
    listEl.createEl('div', { text: '변경 확인 중…', cls: 'ogs-diff-empty' });

    let files: Array<{ status: string; path: string }> = [];
    try {
      files = await this.git.outgoingFiles();
    } catch {
      /* 오프라인/오류 — 빈 목록 */
    }

    listEl.empty();
    if (files.length === 0) {
      listEl.createEl('div', { text: '저장할 변경이 없습니다.', cls: 'ogs-diff-empty' });
    } else {
      listEl.createEl('div', { text: `변경 파일 ${files.length}개`, cls: 'ogs-diff-section-title' });
      for (const f of files) {
        listEl.createEl('div', { text: `${statusLabel(f.status)} ${f.path}`, cls: 'ogs-diff-file' });
      }
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('취소').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText('저장')
          .setCta()
          .setDisabled(files.length === 0)
          .onClick(() => void this.doSave(b)),
      );
  }

  private async doSave(btn: ButtonComponent): Promise<void> {
    btn.setDisabled(true).setButtonText('저장 중…');
    try {
      const result = await this.git.squashMergeToMain();
      new Notice(result === 'saved' ? '저장했습니다 — 공식본에 반영됨 ✓' : '저장할 변경이 없습니다.');
      this.onSaved?.();
      this.close();
    } catch (e) {
      new Notice(`저장 실패: ${errorMsg(e)}\n복구가 필요하면 관리자에게 문의하세요(git reflog).`);
      btn.setDisabled(false).setButtonText('저장');
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function statusLabel(status: string): string {
  const c = status[0];
  if (c === 'A') return '＋';
  if (c === 'D') return '－';
  if (c === 'R') return '↦';
  return '·';
}

function errorMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0].slice(0, 120);
}
