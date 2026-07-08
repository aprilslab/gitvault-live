export type SyncState = 'synced' | 'syncing' | 'pending' | 'error' | 'off';

export type OutgoingFile = { status: string; path: string };

export function statusLabel(s: string): string {
  if (s.startsWith('A')) return '새 파일';
  if (s.startsWith('D')) return '삭제';
  if (s.startsWith('R')) return '이동';
  return '수정';
}

/** hover 툴팁용 미저장 파일 요약 (최대 max 줄 + "…외 N개"). */
export function outgoingSummary(files: OutgoingFile[], max = 8): string {
  const lines = files.slice(0, max).map((f) => `${statusLabel(f.status)} · ${f.path}`);
  if (files.length > max) lines.push(`…외 ${files.length - max}개`);
  return lines.join('\n');
}

/** 상태바 한 칸. 동기화 상태를 비개발자 친화 문구로 표시. */
export class StatusBar {
  private outgoing: OutgoingFile[] = [];

  constructor(
    private readonly el: HTMLElement,
    onOutgoingClick?: (files: OutgoingFile[], evt: MouseEvent) => void,
  ) {
    el.addClass('ogs-statusbar');
    if (onOutgoingClick) {
      el.addClass('mod-clickable');
      el.addEventListener('click', (evt) => {
        if (this.outgoing.length > 0) onOutgoingClick(this.outgoing, evt);
      });
    }
    this.set('off');
  }

  /** 발행 상태: main 대비 미저장 파일. 0 이면 "저장됨", >0 이면 "저장 대기 N" + hover 시 목록. */
  setOutgoing(files: OutgoingFile[]): void {
    this.outgoing = files;
    this.el.removeClass('mod-error', 'mod-syncing', 'mod-pending');
    if (files.length > 0) {
      this.el.addClass('mod-pending');
      this.el.setText(`Git: 저장 대기 ${files.length}`);
      this.el.setAttr('aria-label', `클릭하면 목록\n${outgoingSummary(files)}`);
    } else {
      this.el.setText('Git: 저장됨');
      this.el.setAttr('aria-label', '모든 변경이 공식본(main)에 반영됨');
    }
  }

  set(state: SyncState, detail?: string): void {
    this.el.removeClass('mod-error', 'mod-syncing', 'mod-pending');
    let text: string;
    switch (state) {
      case 'synced':
        text = 'Git: 동기화됨';
        break;
      case 'syncing':
        text = 'Git: 동기화 중…';
        this.el.addClass('mod-syncing');
        break;
      case 'pending':
        text = detail ? `Git: ${detail} 대기` : 'Git: 변경 대기';
        break;
      case 'error':
        text = detail ? `Git: 오류(${detail})` : 'Git: 오류';
        this.el.addClass('mod-error');
        break;
      default:
        text = 'Git: 미연결';
    }
    this.el.setText(text);
    this.el.setAttr('aria-label', state === 'error' && detail ? detail : '');
  }
}
