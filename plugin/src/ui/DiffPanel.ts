import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { GitManager } from '../git/GitManager';

export const VIEW_TYPE_OGS_DIFF = 'ogs-diff-panel';

interface FileChange {
  status: string;
  path: string;
}

/**
 * 사이드 패널: "들어온 변경"(타 참여자가 origin/main 에 올렸고 아직 내 것에 미병합) +
 * "내가 저장할 변경"(wip vs origin/main). 파일 클릭 → 열기.
 * 실시간 아님 — AutoSync 60s 사이클(onSynced)마다 갱신.
 */
export class DiffPanel extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly getGit: () => GitManager | undefined,
    private readonly openPath: (path: string) => void,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OGS_DIFF;
  }
  getDisplayText(): string {
    return '동시 편집 현황';
  }
  getIcon(): string {
    return 'git-compare';
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('ogs-diff-panel');

    const git = this.getGit();
    if (!git) {
      root.createEl('div', { text: '미연결 — 설정에서 저장소를 연결하세요.', cls: 'ogs-diff-empty' });
      return;
    }

    let incoming: FileChange[] = [];
    let outgoing: FileChange[] = [];
    try {
      [incoming, outgoing] = await Promise.all([git.incomingFiles(), git.outgoingFiles()]);
    } catch {
      /* 오프라인/일시 오류 — 빈 목록으로 표시 */
    }
    this.section(root, '들어온 변경 (다른 참여자)', incoming);
    this.section(root, '내가 저장할 변경', outgoing);
  }

  private section(root: HTMLElement, title: string, files: FileChange[]): void {
    root.createEl('div', { text: title, cls: 'ogs-diff-section-title' });
    if (files.length === 0) {
      root.createEl('div', { text: '변경 없음', cls: 'ogs-diff-empty' });
      return;
    }
    for (const f of files) {
      const row = root.createEl('div', { cls: 'ogs-diff-file' });
      row.setText(`${statusLabel(f.status)} ${f.path}`);
      row.addEventListener('click', () => this.openPath(f.path));
    }
  }
}

function statusLabel(status: string): string {
  const c = status[0];
  if (c === 'A') return '＋';
  if (c === 'D') return '－';
  if (c === 'R') return '↦';
  return '·'; // M 등
}
